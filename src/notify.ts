import type { Store } from './store.js';

export class Notifier {
  private readonly lastSent = new Map<string, number>();
  private readonly windowMs = 30 * 60 * 1000;

  constructor(private readonly store: Store, private readonly webhook = '') {}

  async error(scope: string, message: string): Promise<void> {
    this.store.log('error', scope, message);
    console.error(`[${scope}] ${message}`);
    await this.push(`[抖音采集异常] ${scope}\n${message}`);
  }

  warn(scope: string, message: string): void {
    this.store.log('warn', scope, message);
    console.warn(`[${scope}] ${message}`);
  }

  info(scope: string, message: string): void {
    this.store.log('info', scope, message);
    console.log(`[${scope}] ${message}`);
  }

  /** 同类错误 30 分钟内只报一次 */
  private async push(text: string): Promise<void> {
    if (!this.webhook) return;
    const key = text.split('\n')[0] ?? text;
    const now = Date.now();
    const last = this.lastSent.get(key) ?? 0;
    if (now - last < this.windowMs) return;
    this.lastSent.set(key, now);
    try {
      await fetch(this.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text.slice(0, 1800) } }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      this.store.log('warn', 'notify', `webhook 发送失败: ${(err as Error).message}`);
    }
  }
}
