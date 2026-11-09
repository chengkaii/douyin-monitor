import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import type { AppConfig, DownloadConfig, PollingConfig, RetryConfig } from './types.js';

const ROOT = process.cwd();

function env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

function requireFile(p: string, hint: string): string {
  if (!fs.existsSync(p)) {
    throw new Error(`缺少 ${p}；${hint}`);
  }
  return fs.readFileSync(p, 'utf8');
}

const POLLING_DEFAULTS: PollingConfig = {
  intervalMinutes: 5,
  jitterSeconds: 120,
  minGapSeconds: 8,
  nightIntervalMinutes: 15,
  nightStartHour: 0,
  nightEndHour: 6,
};

const DOWNLOAD_DEFAULTS: DownloadConfig = {
  concurrency: 2,
  maxRetries: 3,
  minBytes: 1024 * 1024,
  retryDelaysMs: [30_000, 120_000, 600_000],
};

const RETRY_DEFAULTS: RetryConfig = {
  maxAttempts: 5,
  everyRounds: 20, // serve 每 15s 一轮 → 约 5 分钟扫一次 failed
};

export function loadConfig(options: { requireAccountsFile?: boolean } = {}): AppConfig {
  loadDotenv({ path: resolveFromRoot('.env'), quiet: true });

  const accountsPath = resolveFromRoot(env('ACCOUNTS_FILE', './accounts.yaml'));
  const raw = options.requireAccountsFile === false && !fs.existsSync(accountsPath)
    ? '{}'
    : requireFile(accountsPath, '请复制 accounts.example.yaml 为 accounts.yaml 并填写账号');

  const doc = parseYaml(raw) as Record<string, unknown> | null;
  const root = doc ?? {};
  const accountRows = Array.isArray(root['accounts']) ? (root['accounts'] as Record<string, unknown>[]) : [];
  const pollingRaw = (root['polling'] ?? {}) as Record<string, unknown>;
  const downloadRaw = (root['download'] ?? {}) as Record<string, unknown>;
  const retryRaw = (root['retry'] ?? {}) as Record<string, unknown>;
  const ossRaw = (root['oss'] ?? {}) as Record<string, unknown>;

  const accounts = accountRows.map((a) => ({
    name: String(a['name'] ?? '未命名账号'),
    secUserId: String(a['sec_user_id'] ?? ''),
    enabled: a['enabled'] !== false,
  })).filter((a) => a.secUserId.length > 0);

  const num = (obj: Record<string, unknown>, key: string, fallback: number): number => {
    const v = obj[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const str = (obj: Record<string, unknown>, key: string, fallback: string): string => {
    const v = obj[key];
    return typeof v === 'string' ? v : fallback;
  };

  const polling: PollingConfig = {
    intervalMinutes: num(pollingRaw, 'intervalMinutes', POLLING_DEFAULTS.intervalMinutes),
    jitterSeconds: num(pollingRaw, 'jitterSeconds', POLLING_DEFAULTS.jitterSeconds),
    minGapSeconds: num(pollingRaw, 'minGapSeconds', POLLING_DEFAULTS.minGapSeconds),
    nightIntervalMinutes: num(pollingRaw, 'nightIntervalMinutes', POLLING_DEFAULTS.nightIntervalMinutes),
    nightStartHour: num(pollingRaw, 'nightStartHour', POLLING_DEFAULTS.nightStartHour),
    nightEndHour: num(pollingRaw, 'nightEndHour', POLLING_DEFAULTS.nightEndHour),
  };

  const retryDelays = Array.isArray(downloadRaw['retryDelaysMs'])
    ? (downloadRaw['retryDelaysMs'] as unknown[]).filter((v): v is number => typeof v === 'number')
    : DOWNLOAD_DEFAULTS.retryDelaysMs;

  const download: DownloadConfig = {
    concurrency: num(downloadRaw, 'concurrency', DOWNLOAD_DEFAULTS.concurrency),
    maxRetries: num(downloadRaw, 'maxRetries', DOWNLOAD_DEFAULTS.maxRetries),
    minBytes: num(downloadRaw, 'minBytes', DOWNLOAD_DEFAULTS.minBytes),
    retryDelaysMs: retryDelays,
  };

  const retry: RetryConfig = {
    maxAttempts: Math.max(1, num(
      retryRaw, 'maxAttempts', envInt('RETRY_MAX_ATTEMPTS', RETRY_DEFAULTS.maxAttempts),
    )),
    everyRounds: Math.max(1, num(
      retryRaw, 'everyRounds', envInt('RETRY_FAILED_EVERY_ROUNDS', RETRY_DEFAULTS.everyRounds),
    )),
  };

  const sink = env('SINK', 'local') === 'oss' ? 'oss' : 'local';
  const ossPrefix = str(ossRaw, 'prefix', env('OSS_PREFIX', 'douyin-monitor/'));

  if (sink === 'oss' && (!env('OSS_ACCESS_KEY_ID') || !env('OSS_ACCESS_KEY_SECRET'))) {
    throw new Error('SINK=oss 需要 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET');
  }

  return {
    accounts,
    polling,
    download,
    retry,
    ossPrefix,
    dtk: {
      baseUrl: env('DTK_BASE_URL', 'http://127.0.0.1:8000').replace(/\/$/, ''),
      apiKey: env('DTK_API_KEY'),
      // 已按 v5.1.7 源码（content.py）确认；如实例版本不同，用 npm run inspect-openapi 覆盖
      postsPath: env('DTK_POSTS_PATH', '/api/v1/douyin/user/posts'),
      videoPath: env('DTK_VIDEO_PATH', '/api/v1/douyin/video'),
      taskPath: env('DTK_TASK_PATH', '/api/v1/tasks/{taskId}'),
      postsUserParam: env('DTK_POSTS_USER_PARAM', 'sec_user_id'),
      postsCursorParam: env('DTK_POSTS_CURSOR_PARAM', 'cursor'),
      postsCountParam: env('DTK_POSTS_COUNT_PARAM', 'count'),
      postsCount: envInt('DTK_POSTS_COUNT', 20),
      videoIdParam: env('DTK_VIDEO_ID_PARAM', 'aweme_id'),
      syncWait: envInt('DTK_SYNC_WAIT', 25),
      timeoutMs: envInt('DTK_TIMEOUT_MS', 30_000),
    },
    paths: {
      db: resolveFromRoot(env('DB_PATH', './data/monitor.db')),
      tmp: resolveFromRoot(env('TMP_DIR', './data/tmp')),
      outbox: resolveFromRoot(env('OUTBOX_DIR', './data/outbox')),
      accounts: accountsPath,
    },
    sink,
    oss: {
      region: env('OSS_REGION', 'oss-cn-beijing'),
      bucket: env('OSS_BUCKET', 'ffyc-creator'),
      accessKeyId: env('OSS_ACCESS_KEY_ID'),
      accessKeySecret: env('OSS_ACCESS_KEY_SECRET'),
      prefix: ossPrefix,
    },
    wecomWebhook: env('WECOM_WEBHOOK'),
  };
}

export function ensureDirs(config: AppConfig): void {
  for (const dir of [path.dirname(config.paths.db), config.paths.tmp, config.paths.outbox]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
