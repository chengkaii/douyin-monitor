import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { Notifier, type NotifierOptions } from '../src/notify.js';

const WEBHOOK = 'https://example.com/wecom';

/** 打桩企微 webhook，记录推送文本；返回 false 模拟 4xx/5xx */
function stubFetch(respond: (text: string) => boolean): { texts: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const texts: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { text: { content: string } };
    const text = body.text.content;
    texts.push(text);
    const ok = respond(text);
    return { ok, status: ok ? 200 : 500 } as unknown as Response;
  }) as typeof fetch;
  return { texts, restore: () => { globalThis.fetch = original; } };
}

function quietConsole(): () => void {
  const error = console.error;
  const warn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  return () => { console.error = error; console.warn = warn; };
}

async function withNotifier(
  options: NotifierOptions,
  respond: (text: string) => boolean,
  fn: (n: Notifier, texts: string[], store: Store, advance: (ms: number) => void) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-notify-'));
  const store = new Store(path.join(dir, 'monitor.db'));
  let now = 1_000_000;
  const stub = stubFetch(respond);
  const restoreConsole = quietConsole();
  const notifier = new Notifier(store, WEBHOOK, { ...options, now: () => now });
  try {
    await fn(notifier, stub.texts, store, (ms) => { now += ms; });
  } finally {
    restoreConsole();
    stub.restore();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('不同账号的失败各自上报，不再被同 scope 的 30 分钟窗口互相吞掉', async () => {
  await withNotifier({ maxPerWindow: 5 }, () => true, async (n, texts) => {
    await n.error('poll', '账号A 轮询失败（连续 1 次）: timeout');
    await n.error('poll', '账号B 轮询失败（连续 1 次）: timeout');
    await n.error('poll', '账号C 轮询失败（连续 1 次）: timeout');
    assert.equal(texts.length, 3, '旧实现按首行 scope 去重只会发出第 1 条');
    assert.ok(texts.some((t) => t.includes('账号B')));
    assert.ok(texts.some((t) => t.includes('账号C')));
  });
});

test('同一账号连续失败仍按窗口收敛，连续次数变化不算新错误', async () => {
  await withNotifier({}, () => true, async (n, texts, _store, advance) => {
    for (let i = 1; i <= 3; i += 1) {
      await n.error('poll', `账号A 轮询失败（连续 ${i} 次）: timeout`);
      advance(1_000);
    }
    assert.equal(texts.length, 1);
    assert.match(texts[0] ?? '', /账号A/);
  });
});

test('单窗口超额后收敛并在下个窗口补一条汇总，不刷屏也不丢信号', async () => {
  await withNotifier({ windowMs: 60_000, maxPerWindow: 2 }, () => true, async (n, texts, _store, advance) => {
    for (let i = 1; i <= 5; i += 1) {
      await n.error('poll', `账号${i} 轮询失败: timeout`);
    }
    assert.equal(texts.length, 2, '单 scope 每窗口最多 2 条');

    advance(60_001);
    await n.error('poll', '账号6 轮询失败: timeout');
    assert.equal(texts.length, 4, '1 条汇总 + 1 条新告警');
    assert.match(texts[2] ?? '', /3 条告警被收敛/);
    assert.match(texts[3] ?? '', /账号6/);
  });
});

test('webhook 返回 4xx 不占用收敛窗口，下一条同错误会重试推送', async () => {
  let first = true;
  await withNotifier({}, () => {
    if (first) { first = false; return false; }
    return true;
  }, async (n, texts, store) => {
    await n.error('poll', '账号A 轮询失败: timeout');
    assert.equal(texts.length, 1);
    assert.ok(store.recentLogs(10).some((l) => l.level === 'warn' && l.scope === 'notify'));

    await n.error('poll', '账号A 轮询失败: timeout');
    assert.equal(texts.length, 2, '发送失败必须回滚名额，不能静默吞掉 30 分钟');
  });
});

test('warn 的静默失败信号（登录态失效 / 空列表）也会推到企微', async () => {
  await withNotifier({}, () => true, async (n, texts) => {
    n.warn('poll-empty', '账号A: 首页返回空作品列表，请核对登录态/接口权限是否失效');
    await new Promise((r) => setTimeout(r, 10)); // warn 保持同步签名，推送是 fire-and-forget
    assert.equal(texts.length, 1);
    assert.match(texts[0] ?? '', /采集提示/);
    assert.match(texts[0] ?? '', /空作品列表/);
  });
});
