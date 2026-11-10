import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RawVideo, VideoStatus } from './types.js';

export interface VideoRow {
  video_id: string;
  sec_user_id: string;
  desc: string;
  create_time: number;
  status: VideoStatus;
  local_path: string | null;
  /** 本地 MP4 的完整性指纹，供补传复用与云端校验 */
  local_bytes: number | null;
  local_sha256: string | null;
  oss_key: string | null;
  error: string;
  discovered_at: number;
  uploaded_at: number;
  attempts: number;
}

export interface PollStateRow {
  sec_user_id: string;
  last_poll_at: number;
  next_poll_at: number;
  fail_streak: number;
  last_ok_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS videos (
  video_id      TEXT PRIMARY KEY,
  sec_user_id   TEXT NOT NULL,
  desc          TEXT,
  create_time   INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending',
  local_path    TEXT,
  local_bytes   INTEGER,
  local_sha256  TEXT,
  oss_key       TEXT,
  error         TEXT,
  discovered_at INTEGER NOT NULL,
  uploaded_at   INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE TABLE IF NOT EXISTS poll_state (
  sec_user_id   TEXT PRIMARY KEY,
  last_poll_at  INTEGER NOT NULL,
  next_poll_at  INTEGER NOT NULL,
  fail_streak   INTEGER NOT NULL DEFAULT 0,
  last_ok_at    INTEGER
);
CREATE TABLE IF NOT EXISTS run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT, scope TEXT, message TEXT
);
`;

export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /** 老库补列：v1 建表时没有 attempts / 完整性字段，直接 ALTER，无需删库重建 */
  private migrate(): void {
    const cols = this.db.pragma('table_info(videos)') as Array<{ name: string }>;
    const add = (name: string, ddl: string): void => {
      if (!cols.some((c) => c.name === name)) {
        this.db.exec(`ALTER TABLE videos ADD COLUMN ${name} ${ddl}`);
      }
    };
    add('attempts', 'INTEGER NOT NULL DEFAULT 0');
    add('local_bytes', 'INTEGER');
    add('local_sha256', 'TEXT');
  }

  /**
   * 进程在 downloading 阶段被 kill / 断电后，这行永远不会再进队列。
   * 首次下载中断（无完整性指纹）→ pending 重新下载；
   * 补传中断（已有校验过的完整本地文件）→ downloaded，下一轮直接复用文件补传。
   */
  recoverInterrupted(): number {
    const fresh = this.db.prepare(`
      UPDATE videos SET status = 'pending', local_path = NULL, local_bytes = NULL,
        local_sha256 = NULL, error = NULL
      WHERE status = 'downloading' AND local_bytes IS NULL
    `).run().changes;
    const complete = this.db.prepare(`
      UPDATE videos SET status = 'downloaded', error = NULL
      WHERE status = 'downloading' AND local_bytes IS NOT NULL
    `).run().changes;
    return fresh + complete;
  }

  /** 每次进入 processVideo 都记一次尝试，用于给 failed 自动重投封顶 */
  bumpAttempt(videoId: string): void {
    this.db.prepare('UPDATE videos SET attempts = attempts + 1 WHERE video_id = ?').run(videoId);
  }

  /** 只捞还没到尝试上限的失败行，避免坏视频被无限重投 */
  listRetryable(maxAttempts: number): VideoRow[] {
    return this.db.prepare('SELECT * FROM videos WHERE status = ? AND attempts < ? ORDER BY discovered_at')
      .all('failed', maxAttempts) as VideoRow[];
  }

  countVideos(secUserId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM videos WHERE sec_user_id = ?')
      .get(secUserId) as { n: number }).n;
  }

  /** 只插入没见过的视频；返回本次真正新增的条目（增量去重核心） */
  insertNew(videos: RawVideo[], now = Date.now()): RawVideo[] {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO videos
        (video_id, sec_user_id, desc, create_time, status, local_path, oss_key, error, discovered_at, uploaded_at)
      VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL)
    `);
    const fresh: RawVideo[] = [];
    const run = this.db.transaction((rows: RawVideo[]) => {
      for (const v of rows) {
        const result = stmt.run(v.videoId, v.secUserId, v.desc, v.createTime, now);
        if (result.changes > 0) fresh.push(v);
      }
    });
    run(videos);
    return fresh;
  }

  hasVideo(videoId: string): boolean {
    return this.db.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(videoId) !== undefined;
  }

  setStatus(
    videoId: string,
    status: VideoStatus,
    patch: Partial<Pick<VideoRow, 'local_path' | 'local_bytes' | 'local_sha256' | 'oss_key' | 'error' | 'uploaded_at'>> = {},
  ): void {
    const current = this.getVideo(videoId);
    if (!current) return;
    // 用 hasOwn 区分「没传」和「显式清空」，否则 null 会被 ?? 吞掉
    const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(patch, k);
    this.db.prepare(`
      UPDATE videos SET status = ?, local_path = ?, local_bytes = ?, local_sha256 = ?,
        oss_key = ?, error = ?, uploaded_at = ?
      WHERE video_id = ?
    `).run(
      status,
      has('local_path') ? patch.local_path : current.local_path,
      has('local_bytes') ? patch.local_bytes : current.local_bytes,
      has('local_sha256') ? patch.local_sha256 : current.local_sha256,
      has('oss_key') ? patch.oss_key : current.oss_key,
      patch.error ?? null,
      has('uploaded_at') ? patch.uploaded_at : current.uploaded_at,
      videoId,
    );
  }

  getVideo(videoId: string): VideoRow | undefined {
    return this.db.prepare('SELECT * FROM videos WHERE video_id = ?').get(videoId) as VideoRow | undefined;
  }

  listByStatus(status: VideoStatus): VideoRow[] {
    return this.db.prepare('SELECT * FROM videos WHERE status = ? ORDER BY discovered_at').all(status) as VideoRow[];
  }

  getPollState(secUserId: string): PollStateRow | undefined {
    return this.db.prepare('SELECT * FROM poll_state WHERE sec_user_id = ?').get(secUserId) as PollStateRow | undefined;
  }

  allPollStates(): PollStateRow[] {
    return this.db.prepare('SELECT * FROM poll_state ORDER BY sec_user_id').all() as PollStateRow[];
  }

  setPollState(row: PollStateRow): void {
    this.db.prepare(`
      INSERT INTO poll_state (sec_user_id, last_poll_at, next_poll_at, fail_streak, last_ok_at)
      VALUES (@sec_user_id, @last_poll_at, @next_poll_at, @fail_streak, @last_ok_at)
      ON CONFLICT(sec_user_id) DO UPDATE SET
        last_poll_at = excluded.last_poll_at,
        next_poll_at = excluded.next_poll_at,
        fail_streak  = excluded.fail_streak,
        last_ok_at   = excluded.last_ok_at
    `).run(row);
  }

  log(level: 'info' | 'warn' | 'error', scope: string, message: string): void {
    this.db.prepare('INSERT INTO run_log (ts, level, scope, message) VALUES (?, ?, ?, ?)')
      .run(Date.now(), level, scope, message.slice(0, 1000));
  }

  recentLogs(limit = 20): Array<{ ts: number; level: string; scope: string; message: string }> {
    return this.db.prepare('SELECT ts, level, scope, message FROM run_log ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ ts: number; level: string; scope: string; message: string }>;
  }

  stats(): { total: number; today: number; byStatus: Array<{ status: string; count: number }>; queueDepth: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number }).n;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today = (this.db.prepare('SELECT COUNT(*) AS n FROM videos WHERE discovered_at >= ?')
      .get(startOfDay.getTime()) as { n: number }).n;
    const byStatus = this.db.prepare('SELECT status, COUNT(*) AS count FROM videos GROUP BY status')
      .all() as Array<{ status: string; count: number }>;
    const queueDepth = byStatus
      .filter((r) => ['pending', 'downloading', 'downloaded'].includes(r.status))
      .reduce((sum, r) => sum + r.count, 0);
    return { total, today, byStatus, queueDepth };
  }
}
