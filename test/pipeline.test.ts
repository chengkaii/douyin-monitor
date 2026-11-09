import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startMockDtk } from '../scripts/mock-dtk.js';
import { makeContext } from '../src/context.js';
import { runOnce, runForever, pollAccount } from '../src/pipeline.js';
import { ChannelError } from '../src/channel/types.js';
import type { RawVideo } from '../src/types.js';

function listFiles(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
  });
}

function setEnv(mockUrl: string, dir: string, syncWait: string, extraYaml = ''): void {
  const values: Record<string, string> = {
    ACCOUNTS_FILE: path.join(dir, 'accounts.yaml'),
    DB_PATH: path.join(dir, 'monitor.db'),
    TMP_DIR: path.join(dir, 'tmp'),
    OUTBOX_DIR: path.join(dir, 'outbox'),
    SINK: 'local',
    CHANNEL: 'evil0ctal',
    DTK_BASE_URL: mockUrl,
    DTK_API_KEY: 'dtk_test',
    DTK_POSTS_PATH: '/api/v1/demo/user-posts',
    DTK_POSTS_USER_PARAM: 'sec_user_id',
    DTK_POSTS_CURSOR_PARAM: 'cursor',
    DTK_POSTS_COUNT_PARAM: 'count',
    DTK_POSTS_COUNT: '20',
    DTK_VIDEO_PATH: '/api/v1/demo/video',
    DTK_VIDEO_ID_PARAM: 'aweme_id',
    DTK_TASK_PATH: '/api/v1/tasks/{taskId}',
    DTK_SYNC_WAIT: syncWait,
    DTK_TIMEOUT_MS: '10000',
    WECOM_WEBHOOK: '',
  };
  for (const [k, value] of Object.entries(values)) process.env[k] = value;
  fs.writeFileSync(
    values['ACCOUNTS_FILE']!,
    'accounts:\n  - name: "测试账号"\n    sec_user_id: "MS4wLjABAAAA_TEST_USER"\n    enabled: true\npolling:\n  minGapSeconds: 0\ndownload:\n  retryDelaysMs: [0, 0, 0]\n' + extraYaml,
    'utf8',
  );
}

function rawVideo(id: string): RawVideo {
  return {
    videoId: id,
    secUserId: 'MS4wLjABAAAA_TEST_USER',
    desc: '崩溃恢复测试',
    createTime: 0,
    authorNickname: '',
    authorSignature: '',
    stats: {},
    playUrl: '',
    shareUrl: '',
  };
}

test('端到端（同步模式）：发现 3 条 → 交付 3 组文件 → 第二轮去重为 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-e2e-'));
  const mock = await startMockDtk(0);
  try {
    setEnv(mock.url, dir, '25');
    const ctx = makeContext();
    try {
      const first = await runOnce(ctx, { force: true });
      assert.deepEqual(first.errors, []);
      assert.equal(first.discovered, 3);
      assert.equal(first.uploaded, 3);

      const files = listFiles(path.join(dir, 'outbox'));
      assert.equal(files.filter((f) => f.endsWith('.mp4')).length, 3);
      assert.equal(files.filter((f) => f.endsWith('.json')).length, 3);

      const manifestPath = path.join(dir, 'outbox', files.find((f) => f.endsWith('.json'))!);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      assert.equal(manifest['videoId'], '7450000000000000001');
      assert.equal((manifest['author'] as Record<string, unknown>)['nickname'], '示例账号A');
      assert.ok(String(manifest['videoUrlOss']).includes('.mp4'));

      const second = await runOnce(ctx, { force: true });
      assert.equal(second.discovered, 0);
      assert.equal(second.uploaded, 0);
      assert.equal(ctx.store.stats().total, 3);
      assert.equal(ctx.store.stats().queueDepth, 0);
    } finally {
      ctx.store.close();
    }
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端（v5 异步 202 + task_id 模式）同样跑通', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-async-'));
  const mock = await startMockDtk(0);
  try {
    setEnv(mock.url, dir, '0');
    const ctx = makeContext();
    try {
      const result = await runOnce(ctx, { force: true });
      assert.deepEqual(result.errors, []);
      assert.equal(result.discovered, 3);
      assert.equal(result.uploaded, 3);
      assert.equal(listFiles(path.join(dir, 'outbox')).length, 6);
    } finally {
      ctx.store.close();
    }
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('解析失败 → 触发退避与 error 日志，不会当成「0 新增」清掉失败计数', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-badbody-'));
  const mock = await startMockDtk(0);
  try {
    setEnv(mock.url, dir, '25');
    const ctx = makeContext();
    ctx.channel.listUserVideos = async () => {
      throw new ChannelError('DTK 作品列表响应结构不符（找不到作品数组）');
    };
    try {
      await assert.rejects(
        () => pollAccount(ctx, 'MS4wLjABAAAA_TEST_USER', '测试账号'),
        /结构不符/,
      );
      const state = ctx.store.getPollState('MS4wLjABAAAA_TEST_USER');
      assert.equal(state?.fail_streak, 1);
      assert.ok(state!.next_poll_at > Date.now() + 60_000, '应进入指数退避，而不是按正常周期继续');
      assert.equal(state?.last_ok_at, 0, '失败轮不能刷新 last_ok_at');
      assert.ok(ctx.store.recentLogs(10).some((l) => l.level === 'error' && l.scope === 'poll'));
    } finally {
      ctx.store.close();
    }
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('老账号突然返回合法空列表 → 留 warn 信号', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-empty-'));
  const mock = await startMockDtk(0);
  try {
    setEnv(mock.url, dir, '25');
    const ctx = makeContext();
    ctx.store.insertNew([rawVideo('7450000000000000001')], Date.now());
    // 模拟"老账号"：已有成功轮询记录，这样告警条件走的是"历史有作品"分支
    ctx.store.setPollState({
      sec_user_id: 'MS4wLjABAAAA_TEST_USER',
      last_poll_at: 1, next_poll_at: 2, fail_streak: 0, last_ok_at: 1,
    });
    ctx.channel.listUserVideos = async () => ({ videos: [], nextCursor: '0', hasMore: false });
    try {
      assert.equal(await pollAccount(ctx, 'MS4wLjABAAAA_TEST_USER', '测试账号'), 0);
      assert.equal(ctx.store.getPollState('MS4wLjABAAAA_TEST_USER')?.fail_streak, 0);
      assert.ok(ctx.store.recentLogs(10).some((l) => l.level === 'warn' && l.scope === 'poll-empty'));
    } finally {
      ctx.store.close();
    }
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('崩溃恢复：遗留 downloading 在重启后回到 pending 并被重新交付', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-crash-'));
  const mock = await startMockDtk(0);
  try {
    setEnv(mock.url, dir, '25');
    const crashed = makeContext();
    crashed.store.insertNew([rawVideo('7450000000000000001')], Date.now());
    crashed.store.setStatus('7450000000000000001', 'downloading', { local_path: '/tmp/half.mp4' });

    // 旧进程视角：队列不收 downloading，这条永远不会被处理（复现 review #1）
    const stuck = await runOnce(crashed, { accountName: '__none__' });
    assert.equal(stuck.uploaded, 0);
    assert.equal(crashed.store.getVideo('7450000000000000001')?.status, 'downloading');
    crashed.store.close();

    const restarted = makeContext();
    try {
      assert.equal(restarted.store.listByStatus('downloading').length, 0);
      assert.equal(restarted.store.getVideo('7450000000000000001')?.status, 'pending');
      const summary = await runOnce(restarted, { force: true });
      assert.equal(summary.discovered, 2, '恢复的那条已见过，另 2 条才是新发现');
      assert.equal(summary.uploaded, 3);
      assert.equal(restarted.store.getVideo('7450000000000000001')?.status, 'uploaded');
      assert.equal(restarted.store.stats().queueDepth, 0);
    } finally {
      restarted.store.close();
    }
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed 重投受 attempts 上限封顶，--force 可突破', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-cap-'));
  const mock = await startMockDtk(0);
  try {
    setEnv(mock.url, dir, '25', '\nretry:\n  maxAttempts: 2\n  everyRounds: 1\n');
    const ctx = makeContext();
    let calls = 0;
    ctx.channel.resolveVideo = async () => {
      calls += 1;
      throw new Error('模拟永久失败');
    };
    try {
      const first = await runOnce(ctx, { force: true });
      assert.equal(first.discovered, 3);
      assert.equal(first.failed, 3);
      assert.equal(calls, 3);

      await runOnce(ctx, { includeFailed: true });
      assert.equal(calls, 6, '第 2 次尝试：3 条重投');
      await runOnce(ctx, { includeFailed: true });
      assert.equal(calls, 6, '到达上限后不再重投');
      assert.equal(ctx.store.getVideo('7450000000000000001')?.attempts, 2);
      assert.equal(ctx.store.listRetryable(2).length, 0);
      assert.equal(ctx.store.listByStatus('failed').length, 3, '封顶的行保留在库里可人工排查');

      await runOnce(ctx, { includeFailed: true, ignoreRetryCap: true });
      assert.equal(calls, 9, '人工 --force 可突破上限');
      assert.equal(ctx.store.getVideo('7450000000000000001')?.attempts, 3);
    } finally {
      ctx.store.close();
    }
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve 模式自动重投 failed，无需人工 retry-failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-serve-'));
  const mock = await startMockDtk(0);
  try {
    setEnv(mock.url, dir, '25', '\nretry:\n  maxAttempts: 3\n  everyRounds: 1\n');
    const ctx = makeContext();
    const original = ctx.channel.resolveVideo.bind(ctx.channel);
    let calls = 0;
    ctx.channel.resolveVideo = async (video) => {
      calls += 1;
      if (calls === 1) throw new Error('模拟首次网络抖动');
      return original(video);
    };

    const stop = { stopped: false };
    const watcher = setInterval(() => {
      if (ctx.store.listByStatus('uploaded').length === 3 && ctx.store.listByStatus('failed').length === 0) {
        stop.stopped = true;
      }
    }, 5);
    const guard = setTimeout(() => { stop.stopped = true; }, 3_000);

    try {
      await runForever(ctx, stop, { tickMs: 10 });
      assert.equal(ctx.store.listByStatus('uploaded').length, 3, '失败行应被自动重投并交付');
      assert.equal(ctx.store.listByStatus('failed').length, 0);
      assert.ok(calls >= 4, '至少经过一次重投');
      assert.ok(ctx.store.listByStatus('uploaded').some((r) => r.attempts === 2));
    } finally {
      clearInterval(watcher);
      clearTimeout(guard);
      ctx.store.close();
    }
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
