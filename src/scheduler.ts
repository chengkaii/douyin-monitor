import type { AccountConfig, PollingConfig } from './types.js';
import type { PollStateRow } from './store.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const MAX_BACKOFF_MS = 24 * HOUR_MS;

export function isNight(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

/** 指数退避：连续失败 n 次后，间隔 = base × 2^n，上限 24h */
export function backoffMs(baseMs: number, failStreak: number): number {
  if (failStreak <= 0) return baseMs;
  return Math.min(baseMs * 2 ** Math.min(failStreak, 12), MAX_BACKOFF_MS);
}

/** 按指定时区取小时。Linux 服务器多跑 UTC，直接用 getHours() 会把北京时间夜间错判成白天 */
export function hourInTimeZone(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isFinite(hour) ? hour : date.getHours();
  } catch {
    return date.getHours(); // 时区名非法时退回本地时间，行为可预期
  }
}

export function nextPollDelayMs(
  polling: PollingConfig,
  failStreak: number,
  now = new Date(),
): number {
  const night = isNight(hourInTimeZone(now, polling.timeZone), polling.nightStartHour, polling.nightEndHour);
  const minutes = night ? polling.nightIntervalMinutes : polling.intervalMinutes;
  const base = Math.max(1, minutes) * MINUTE_MS;
  const jitter = Math.floor(Math.random() * Math.max(0, polling.jitterSeconds) * 1000);
  return backoffMs(base, failStreak) + jitter;
}

export function isDue(state: PollStateRow | undefined, now = Date.now()): boolean {
  return state === undefined || state.next_poll_at <= now;
}

/**
 * 全局最小间隔限速器：所有 DTK 请求（列表 + 视频详情）共用一个实例，串行错峰。
 * 采用「先预约、后 sleep」：并发调用会拿到递增的放行时间，不会同时穿透。
 */
export class RateLimiter {
  private nextAt = 0;
  private lastNow = 0;

  constructor(
    private readonly minGapMs: number,
    /** 仅测试注入，避免真的 sleep；生产用默认实现 */
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> =
      (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async acquire(): Promise<void> {
    const now = this.clock();
    // 系统时钟回拨（NTP 校时）时丢弃落在未来的预约点，否则会白等一大段
    if (now < this.lastNow) this.nextAt = now;
    this.lastNow = now;
    // 关键：在 await 之前就把名额占掉。若在 sleep 之后才写 lastAt，
    // 并发调用会读到同一个旧值、算出同一个 wait，一起放行。
    const scheduledAt = Math.max(now, this.nextAt + this.minGapMs);
    this.nextAt = scheduledAt;
    const wait = scheduledAt - now;
    if (wait > 0) await this.sleep(wait);
  }

  /** 测试用：下一次可预约的时间戳 */
  snapshot(): number {
    return this.nextAt;
  }
}

export function dueAccounts(
  accounts: AccountConfig[],
  getState: (id: string) => PollStateRow | undefined,
  now = Date.now(),
): AccountConfig[] {
  return accounts.filter((a) => a.enabled && isDue(getState(a.secUserId), now));
}
