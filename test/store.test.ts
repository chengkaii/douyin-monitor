import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { Store } from '../src/store.js';
import type { RawVideo } from '../src/types.js';

function withStore(fn: (store: Store) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-test-'));
  const store = new Store(path.join(dir, 'test.db'));
  try {
    fn(store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const v = (id: string): RawVideo => ({
  videoId: id,
  secUserId: 'user-a',
  desc: `文案 ${id}`,
  createTime: 1762400000,
  authorNickname: 'A',
  authorSignature: '',
  stats: {},
  playUrl: '',
  shareUrl: '',
});

test('增量去重：重复 video_id 只算一次新增', () => {
  withStore((store) => {
    assert.equal(store.insertNew([v('1'), v('2')], 1000).length, 2);
    assert.equal(store.insertNew([v('2'), v('3')], 2000).length, 1);
    assert.equal(store.stats().total, 3);
    assert.equal(store.hasVideo('1'), true);
    assert.equal(store.hasVideo('999'), false);
  });
});

test('状态流转与补传查询', () => {
  withStore((store) => {
    store.insertNew([v('1')], 1000);
    store.setStatus('1', 'downloading');
    assert.equal(store.getVideo('1')?.status, 'downloading');
    store.setStatus('1', 'downloaded', { local_path: '/tmp/1.mp4' });
    assert.equal(store.getVideo('1')?.local_path, '/tmp/1.mp4');
    assert.equal(store.listByStatus('downloaded').length, 1);
    store.setStatus('1', 'uploaded', { oss_key: 'douyin-monitor/a.mp4', uploaded_at: 3000 });
    assert.equal(store.getVideo('1')?.status, 'uploaded');
    assert.equal(store.listByStatus('uploaded')[0]?.oss_key, 'douyin-monitor/a.mp4');
  });
});

test('轮询状态 upsert 与队列深度统计', () => {
  withStore((store) => {
    store.setPollState({ sec_user_id: 'user-a', last_poll_at: 1, next_poll_at: 2, fail_streak: 0, last_ok_at: 1 });
    store.setPollState({ sec_user_id: 'user-a', last_poll_at: 3, next_poll_at: 4, fail_streak: 2, last_ok_at: 1 });
    assert.equal(store.allPollStates().length, 1);
    assert.equal(store.getPollState('user-a')?.fail_streak, 2);

    store.insertNew([v('1'), v('2')], 1000);
    store.setStatus('1', 'uploaded');
    assert.equal(store.stats().queueDepth, 1);
  });
});

test('崩溃恢复：遗留 downloading 重置为 pending，其他状态不受影响', () => {
  withStore((store) => {
    store.insertNew([v('1'), v('2'), v('3')], 1000);
    store.setStatus('1', 'downloading', { local_path: '/tmp/half.mp4' });
    store.setStatus('2', 'downloaded', { local_path: '/tmp/2.mp4' });
    store.setStatus('3', 'uploaded');

    assert.equal(store.recoverInterrupted(), 1);
    assert.equal(store.getVideo('1')?.status, 'pending');
    assert.equal(store.getVideo('1')?.local_path, null);
    assert.equal(store.getVideo('2')?.status, 'downloaded');
    assert.equal(store.getVideo('3')?.status, 'uploaded');
    assert.equal(store.recoverInterrupted(), 0, '恢复操作幂等');
  });
});

test('attempts 计数与 listRetryable 上限', () => {
  withStore((store) => {
    store.insertNew([v('1'), v('2')], 1000);
    store.bumpAttempt('1');
    assert.equal(store.getVideo('1')?.attempts, 1);
    store.setStatus('1', 'failed', { error: 'boom' });
    store.setStatus('2', 'failed', { error: 'boom' });

    assert.equal(store.listRetryable(2).length, 2);
    store.bumpAttempt('1');
    assert.deepEqual(store.listRetryable(2).map((r) => r.video_id), ['2']);
    assert.equal(store.listByStatus('failed').length, 2, '封顶的行仍在库里，不会被误删');
  });
});

test('崩溃恢复：补传中断（已有完整本地文件）回 downloaded，首次下载中断回 pending', () => {
  withStore((store) => {
    store.insertNew([v('1'), v('2')], 1000);
    store.setStatus('1', 'downloaded', {
      local_path: '/tmp/1.mp4', local_bytes: 2048, local_sha256: 'a'.repeat(64),
    });
    store.setStatus('1', 'downloading'); // 补传到一半被 kill，完整性指纹仍在
    store.setStatus('2', 'downloading'); // 首次下载中断，没有可用文件

    assert.equal(store.recoverInterrupted(), 2);
    assert.equal(store.getVideo('1')?.status, 'downloaded');
    assert.equal(store.getVideo('1')?.local_path, '/tmp/1.mp4');
    assert.equal(store.getVideo('1')?.local_sha256, 'a'.repeat(64));
    assert.equal(store.getVideo('2')?.status, 'pending');
    assert.equal(store.getVideo('2')?.local_path, null);
    assert.equal(store.getVideo('2')?.local_bytes, null);
  });
});

test('setStatus 显式传 null 能清空本地文件指针（不被 ?? 吞掉）', () => {
  withStore((store) => {
    store.insertNew([v('1')], 1000);
    store.setStatus('1', 'downloaded', {
      local_path: '/tmp/1.mp4', local_bytes: 2048, local_sha256: 'a'.repeat(64),
    });
    store.setStatus('1', 'uploaded', {
      local_path: null, local_bytes: null, local_sha256: null,
    });
    const row = store.getVideo('1');
    assert.equal(row?.status, 'uploaded');
    assert.equal(row?.local_path, null);
    assert.equal(row?.local_bytes, null);
    assert.equal(row?.local_sha256, null);
  });
});

test('老库自动补 attempts 列（无需删库重建）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-migrate-'));
  const dbPath = path.join(dir, 'legacy.db');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE videos (
      video_id TEXT PRIMARY KEY, sec_user_id TEXT NOT NULL, desc TEXT, create_time INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', local_path TEXT, oss_key TEXT, error TEXT,
      discovered_at INTEGER NOT NULL, uploaded_at INTEGER
    );
    INSERT INTO videos (video_id, sec_user_id, discovered_at, status)
      VALUES ('legacy', 'user-a', 1000, 'downloading');
  `);
  legacy.close();

  const store = new Store(dbPath);
  try {
    assert.equal(store.getVideo('legacy')?.attempts, 0);
    assert.equal(store.recoverInterrupted(), 1);
    assert.equal(store.getVideo('legacy')?.status, 'pending');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
