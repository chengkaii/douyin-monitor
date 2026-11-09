export interface AccountConfig {
  name: string;
  secUserId: string;
  enabled: boolean;
}

export interface PollingConfig {
  intervalMinutes: number;
  jitterSeconds: number;
  minGapSeconds: number;
  nightIntervalMinutes: number;
  nightStartHour: number;
  nightEndHour: number;
}

export interface DownloadConfig {
  concurrency: number;
  maxRetries: number;
  minBytes: number;
  retryDelaysMs: number[];
}

/** failed 行的自动重投策略（serve 模式） */
export interface RetryConfig {
  maxAttempts: number;   // 单条视频跨轮最多处理次数（1 次首发 + N 次重投）
  everyRounds: number;   // serve 每 N 轮扫一次 failed
}

export interface AppConfig {
  accounts: AccountConfig[];
  polling: PollingConfig;
  download: DownloadConfig;
  retry: RetryConfig;
  ossPrefix: string;
  dtk: {
    baseUrl: string;
    apiKey: string;
    postsPath: string;
    videoPath: string;
    taskPath: string;
    postsUserParam: string;
    postsCursorParam: string;
    postsCountParam: string;
    postsCount: number;
    videoIdParam: string;
    syncWait: number;
    timeoutMs: number;
  };
  paths: {
    db: string;
    tmp: string;
    outbox: string;
    accounts: string;
  };
  sink: 'local' | 'oss';
  oss: {
    region: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    prefix: string;
  };
  wecomWebhook: string;
}

/** 归一化后的视频（屏蔽 DTK 各版本字段差异） */
export interface RawVideo {
  videoId: string;
  desc: string;
  createTime: number;
  authorNickname: string;
  authorSignature: string;
  stats: Record<string, number>;
  playUrl: string;
  shareUrl: string;
  secUserId: string;
}

export interface VideoListResult {
  videos: RawVideo[];
  nextCursor: string;
  hasMore: boolean;
}

export interface Manifest {
  videoId: string;
  secUserId: string;
  author: { nickname: string; signature: string };
  desc: string;
  createTime: number;
  stats: Record<string, number>;
  sourceUrl: string;
  videoFile: string;
  discoveredAt: number;
  uploadedAt: number;
  [key: string]: unknown;
}

export type VideoStatus =
  | 'pending'
  | 'downloading'
  | 'downloaded'
  | 'uploaded'
  | 'failed';
