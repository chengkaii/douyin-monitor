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

export function nextPollDelayMs(
  polling: PollingConfig,
  failStreak: number,
  now = new Date(),
): number {
  const night = isNight(now.getHours(), polling.nightStartHour, polling.nightEndHour);
  const minutes = night ? polling.nightIntervalMinutes : polling.intervalMinutes;
  const base = Math.max(1, minutes) * MINUTE_MS;
  const jitter = Math.floor(Math.random() * Math.max(0, polling.jitterSeconds) * 1000);
  return backoffMs(base, failStreak) + jitter;
}

export function isDue(state: PollStateRow | undefined, now = Date.now()): boolean {
  return state === undefined || state.next_poll_at <= now;
}

/** 全局最小间隔限速器：20+ 账号错峰串行，避免整齐划一的请求模式 */
export class RateLimiter {
  private lastAt = 0;

  constructor(private readonly minGapMs: number) {}

  async acquire(): Promise<void> {
    const wait = this.lastAt + this.minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastAt = Date.now();
  }

  /** 测试用：注入时钟，避免真的 sleep */
  snapshot(): number {
    return this.lastAt;
  }
}

export function dueAccounts(
  accounts: AccountConfig[],
  getState: (id: string) => PollStateRow | undefined,
  now = Date.now(),
): AccountConfig[] {
  return accounts.filter((a) => a.enabled && isDue(getState(a.secUserId), now));
}
