import type { Store } from './store.js';

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PER_WINDOW = 5;

export interface NotifierOptions {
  /** 同类错误的收敛窗口，默认 30 分钟 */
  windowMs?: number;
  /** 单个 scope 在窗口内最多推送几条，防 20+ 账号同时失败刷屏 */
  maxPerWindow?: number;
  /** 仅测试注入 */
  now?: () => number;
}

/** 告警主体：账号名 / videoId / 固定事件名，让不同主体各自有机会上报 */
function subjectOf(message: string): string {
  return /^[^\s:：]+/.exec(message)?.[0] ?? '';
}

/** 归一化错误种类：抹掉连续次数、ID、URL，同类错误落同一个 key */
function errorKind(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

export class Notifier {
  private readonly lastSent = new Map<string, number>();
  private readonly sentByScope = new Map<string, number>();
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private readonly now: () => number;
  private windowStart = 0;
  private suppressedInWindow = 0;

  constructor(
    private readonly store: Store,
    private readonly webhook = '',
    options: NotifierOptions = {},
  ) {
    this.windowMs = Math.max(1, options.windowMs ?? DEFAULT_WINDOW_MS);
    this.maxPerWindow = Math.max(1, options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW);
    this.now = options.now ?? Date.now;
  }

  async error(scope: string, message: string): Promise<void> {
    this.store.log('error', scope, message);
    console.error(`[${scope}] ${message}`);
    await this.push('异常', scope, message);
  }

  warn(scope: string, message: string): void {
    this.store.log('warn', scope, message);
    console.warn(`[${scope}] ${message}`);
    // 静默失败（登录态失效、老账号突然空列表）也要能到企微；保持原有同步签名
    void this.push('提示', scope, message);
  }

  info(scope: string, message: string): void {
    this.store.log('info', scope, message);
    console.log(`[${scope}] ${message}`);
  }

  /**
   * 按「scope + 主体 + 归一化错误」收敛：
   * - 旧实现 key 只取首行 `[抖音采集异常] {scope}`，20 个账号只有第一个失败能报出来；
   * - 现在每个账号/视频各自有窗口，同一账号连续失败仍只报一条；
   * - 每个 scope 单窗口上限 5 条，超出部分计数汇总，既覆盖又不刷屏。
   */
  private async push(level: '异常' | '提示', scope: string, message: string): Promise<void> {
    if (!this.webhook) return;
    const now = this.now();

    if (now - this.windowStart >= this.windowMs) {
      const suppressed = this.suppressedInWindow;
      this.lastSent.clear();
      this.sentByScope.clear();
      this.windowStart = now;
      this.suppressedInWindow = 0;
      if (suppressed > 0) {
        try {
          await this.deliver(
            `[抖音采集汇总] 上一个收敛窗口内有 ${suppressed} 条告警被收敛，明细见 run_log / journald`,
          );
        } catch (err) {
          this.store.log('warn', 'notify', `汇总告警发送失败: ${(err as Error).message}`);
        }
      }
    }

    const key = `${scope}|${subjectOf(message)}|${errorKind(message)}`;
    const last = this.lastSent.get(key);
    const sent = this.sentByScope.get(scope) ?? 0;
    // 必须用 has/get 区分「从没发过」与「时间戳为 0」，否则 ?? 0 会把首次告警吞掉
    if ((last !== undefined && now - last < this.windowMs) || sent >= this.maxPerWindow) {
      this.suppressedInWindow += 1;
      return;
    }

    // 先占位再发：并发的 error/warn 不会一起越过窗口上限；发送失败则回滚名额重试
    this.lastSent.set(key, now);
    this.sentByScope.set(scope, sent + 1);
    try {
      await this.deliver(`[抖音采集${level}] ${scope}\n${message}`);
    } catch (err) {
      this.lastSent.delete(key);
      this.sentByScope.set(scope, Math.max(0, (this.sentByScope.get(scope) ?? 1) - 1));
      this.store.log('warn', 'notify', `webhook 发送失败: ${(err as Error).message}`);
    }
  }

  private async deliver(text: string): Promise<void> {
    const response = await fetch(this.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text.slice(0, 1800) } }),
      signal: AbortSignal.timeout(5_000),
    });
    // 企微返回 4xx/5xx 时不能算「已通知」，否则会静默吞掉整个收敛窗口
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }
}
