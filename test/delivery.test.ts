import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startMockDtk } from '../scripts/mock-dtk.js';
import { makeContext } from '../src/context.js';
import { runOnce } from '../src/pipeline.js';
import { sha256File } from '../src/downloader.js';
import { LocalSink, type Sink } from '../src/sink.js';
import type { RawVideo } from '../src/types.js';

const VIDEO_ID = '7450000000000000001';
const USER_ID = 'MS4wLjABAAAA_TEST_USER';
const VIDEO_BYTES = 1024 * 1024 + 512; // 与 mock 假视频等长，但内容不同，便于辨认是否复用

function listFiles(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
  });
}

function setEnv(mockUrl: string, dir: string): void {
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
    DTK_SYNC_WAIT: '25',
    DTK_TIMEOUT_MS: '10000',
    WECOM_WEBHOOK: '',
  };
  for (const [k, value] of Object.entries(values)) process.env[k] = value;
  fs.writeFileSync(
    values['ACCOUNTS_FILE']!,
    `accounts:\n  - name: "测试账号"\n    sec_user_id: "${USER_ID}"\n    enabled: true\npolling:\n  minGapSeconds: 0\ndownload:\n  retryDelaysMs: [0, 0, 0]\n`,
    'utf8',
  );
}

function rawVideo(): RawVideo {
  return {
    videoId: VIDEO_ID,
    secUserId: USER_ID,
    desc: '补传复用测试',
    createTime: 0,
    authorNickname: '',
    authorSignature: '',
    stats: {},
    playUrl: '',
    shareUrl: '',
  };
}

/** 造一条「已下载完整、等待上传」的老任务，本地文件内容与 mock 视频不同 */
async function seedDownloaded(
  dir: string,
  fill: number,
): Promise<{ ctx: ReturnType<typeof makeContext>; localPath: string; sha256: string }> {
  const ctx = makeContext();
  ctx.store.insertNew([rawVideo()], Date.now());
  const localPath = path.join(dir, 'tmp', `${VIDEO_ID}.mp4`);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, Buffer.alloc(VIDEO_BYTES, fill));
  const sha256 = await sha256File(localPath);
  ctx.store.setStatus(VIDEO_ID, 'downloaded', {
    local_path: localPath,
    local_bytes: VIDEO_BYTES,
    local_sha256: sha256,
  });
  return { ctx, localPath, sha256 };
}

function outboxPair(dir: string): { mp4: string; json: string } {
  const files = listFiles(path.join(dir, 'outbox'));
  return {
    mp4: files.find((f) => f.endsWith('.mp4')) ?? '',
    json: files.find((f) => f.endsWith('.json')) ?? '',
  };
}

async function withMock(fn: (mockUrl: string, dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-delivery-'));
  const mock = await startMockDtk(0);
  try {
    setEnv(mock.url, dir);
    await fn(mock.url, dir);
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('downloaded 补传复用已校验的本地文件，不再重新下载；manifest 带完整性指纹', async () => {
  await withMock(async (_url, dir) => {
    const { ctx, localPath, sha256 } = await seedDownloaded(dir, 0x41);
    try {
      const summary = await runOnce(ctx, { accountName: '__none__' });
      assert.deepEqual(summary.errors, []);
      assert.equal(summary.uploaded, 1);

      const pair = outboxPair(dir);
      assert.ok(pair.mp4 && pair.json);
      assert.equal(
        fs.readFileSync(path.join(dir, 'outbox', pair.mp4))[0], 0x41,
        '交付内容应来自预置本地文件（0x41），mock 视频是 0x00，说明没有重新下载',
      );
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'outbox', pair.json), 'utf8')) as Record<string, unknown>;
      assert.equal(manifest['videoSha256'], sha256);
      assert.equal(manifest['videoBytes'], VIDEO_BYTES);
      assert.equal(ctx.store.getVideo(VIDEO_ID)?.status, 'uploaded');
      assert.equal(fs.existsSync(localPath), false, '上传成功后再删除本地文件');
      assert.equal(fs.readdirSync(path.join(dir, 'tmp')).length, 0, '临时目录不留 MP4/JSON 残留');
    } finally {
      ctx.store.close();
    }
  });
});

test('本地文件被篡改（sha256 不符）→ 拒绝复用，回退重新下载', async () => {
  await withMock(async (_url, dir) => {
    const { ctx, localPath, sha256 } = await seedDownloaded(dir, 0x41);
    fs.writeFileSync(localPath, Buffer.alloc(VIDEO_BYTES, 0x42)); // 内容变了，DB 仍是旧指纹
    try {
      const summary = await runOnce(ctx, { accountName: '__none__' });
      assert.equal(summary.uploaded, 1);
      const pair = outboxPair(dir);
      assert.equal(
        fs.readFileSync(path.join(dir, 'outbox', pair.mp4))[0], 0x00,
        '应重新下载 mock 视频（全 0），而不是交付被篡改的文件',
      );
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'outbox', pair.json), 'utf8')) as Record<string, unknown>;
      assert.notEqual(manifest['videoSha256'], sha256);
      assert.equal(manifest['videoBytes'], VIDEO_BYTES);
    } finally {
      ctx.store.close();
    }
  });
});

test('上传失败保留完整 MP4 与 downloaded 状态，JSON 不残留；下一轮直接补传成功', async () => {
  await withMock(async (_url, dir) => {
    const { ctx, localPath } = await seedDownloaded(dir, 0x41);
    class FailingSink implements Sink {
      readonly name = 'failing';
      async put(): Promise<{ url: string }> {
        throw new Error('模拟 OSS 故障');
      }
    }
    try {
      ctx.sink = new FailingSink();
      const first = await runOnce(ctx, { accountName: '__none__' });
      assert.equal(first.failed, 1);
      assert.equal(ctx.store.getVideo(VIDEO_ID)?.status, 'downloaded', '文件完好时不应掉进 failed 重投');
      assert.ok(fs.existsSync(localPath), '完整 MP4 必须保留给补传');
      assert.equal(fs.readFileSync(localPath)[0], 0x41);
      assert.equal(fs.readdirSync(path.join(dir, 'tmp')).filter((f) => f.endsWith('.json')).length, 0, '失败分支不留 JSON');
      assert.equal(outboxPair(dir).json, '', 'MP4 没成功，不能先写就绪标记');

      ctx.sink = new LocalSink(path.join(dir, 'outbox'));
      const second = await runOnce(ctx, { accountName: '__none__' });
      assert.equal(second.uploaded, 1);
      const pair = outboxPair(dir);
      assert.ok(pair.mp4 && pair.json);
      assert.equal(fs.readFileSync(path.join(dir, 'outbox', pair.mp4))[0], 0x41, '补传仍复用原文件');
      assert.equal(fs.existsSync(localPath), false, '交付成功后清理本地');
    } finally {
      ctx.store.close();
    }
  });
});

test('MP4 上传后远端大小不符 → 拒绝写 JSON，避免孤儿就绪标记', async () => {
  await withMock(async (_url, dir) => {
    const { ctx, localPath } = await seedDownloaded(dir, 0x41);
    class WrongSizeSink implements Sink {
      readonly name = 'wrong-size';
      private readonly inner = new LocalSink(path.join(dir, 'outbox'));
      async put(key: string, filePath: string): Promise<{ url: string }> {
        return this.inner.put(key, filePath);
      }
      async stat(key: string): Promise<{ size: number } | undefined> {
        return key.endsWith('.mp4') ? { size: 1 } : this.inner.stat(key);
      }
    }
    try {
      ctx.sink = new WrongSizeSink();
      const summary = await runOnce(ctx, { accountName: '__none__' });
      assert.equal(summary.failed, 1);
      assert.match(summary.errors[0] ?? '', /MP4 交付校验失败/);
      assert.equal(outboxPair(dir).json, '', '配对校验不过，JSON 不能落地');
      assert.equal(ctx.store.getVideo(VIDEO_ID)?.status, 'downloaded');
      assert.ok(fs.existsSync(localPath));
    } finally {
      ctx.store.close();
    }
  });
});

test('LocalSink 幂等：同 key 同大小不重复覆盖已上传对象', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-monitor-idempotent-'));
  try {
    const sink = new LocalSink(path.join(dir, 'outbox'));
    const src = path.join(dir, 'a.mp4');
    fs.writeFileSync(src, Buffer.alloc(2048, 0x41));
    const first = await sink.put('douyin-monitor/u/202611/a.mp4', src);
    assert.equal(first.url.startsWith('file://'), true);
    assert.deepEqual(await sink.stat('douyin-monitor/u/202611/a.mp4'), { size: 2048 });

    fs.writeFileSync(src, Buffer.alloc(2048, 0x42)); // 同大小、不同内容
    await sink.put('douyin-monitor/u/202611/a.mp4', src);
    const target = path.join(dir, 'outbox', 'douyin-monitor/u/202611/a.mp4');
    assert.equal(fs.readFileSync(target)[0], 0x41, '已有同尺寸对象应跳过覆盖');
    assert.equal(await sink.stat('missing/key'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
