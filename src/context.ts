import { loadConfig, ensureDirs } from './config.js';
import { Store } from './store.js';
import { createChannel } from './channel/index.js';
import { createSink } from './sink.js';
import { Notifier } from './notify.js';
import { RateLimiter } from './scheduler.js';
import type { PipelineContext } from './pipeline.js';

export function makeContext(
  requireAccountsFile = true,
  options: { recover?: boolean } = {},
): PipelineContext {
  const config = loadConfig({ requireAccountsFile });
  ensureDirs(config);
  const store = new Store(config.paths.db);
  if (options.recover !== false) {
    const recovered = store.recoverInterrupted();
    if (recovered > 0) {
      const message = `恢复 ${recovered} 条中断任务：downloading → pending`;
      store.log('warn', 'startup', message);
      console.warn(`[startup] ${message}`);
    }
  }
  return {
    config,
    store,
    channel: createChannel(config),
    sink: createSink(config),
    notifier: new Notifier(store, config.wecomWebhook),
    limiter: new RateLimiter(config.polling.minGapSeconds * 1000),
    now: () => Date.now(),
  };
}
