import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Evil0ctalChannel } from '../src/channel/evil0ctal.js';
import type { AppConfig } from '../src/types.js';

/**
 * review #2 回归：HTTP 200 的错误体 / 字段改名 / ID 解析不出来，
 * 以前会被当成「账号没发新作品」静默记 0 新增，现在必须抛 ChannelError。
 */
test('DTK 作品列表：结构不符必须报错，合法空列表才算 0 新增', async (t) => {
  let payload: unknown = {};
  let statusCode = 200;
  const server = http.createServer((_req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  const cfg: AppConfig['dtk'] = {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: '',
    postsPath: '/api/v1/user-posts',
    videoPath: '/api/v1/video',
    taskPath: '/api/v1/tasks/{taskId}',
    postsUserParam: 'sec_user_id',
    postsCursorParam: 'cursor',
    postsCountParam: 'count',
    postsCount: 20,
    videoIdParam: 'aweme_id',
    syncWait: 25,
    timeoutMs: 5_000,
  };
  const channel = new Evil0ctalChannel(cfg);

  try {
    await t.test('HTTP 200 的错误体 → ChannelError，且带上服务端提示', async () => {
      statusCode = 200;
      payload = { code: -1, message: '登录态失效', data: null };
      await assert.rejects(
        () => channel.listUserVideos('MS4wLjABAAAA_TEST', '0'),
        (err: Error) => err.name === 'ChannelError'
          && err.message.includes('结构不符')
          && err.message.includes('登录态失效'),
      );
    });

    await t.test('响应里完全没有作品数组容器 → ChannelError', async () => {
      payload = { success: false, error: 'forbidden' };
      await assert.rejects(
        () => channel.listUserVideos('MS4wLjABAAAA_TEST', '0'),
        (err: Error) => err.name === 'ChannelError' && err.message.includes('结构不符'),
      );
    });

    await t.test('字段改名导致整页解析不出 video_id → ChannelError', async () => {
      payload = { data: { posts: [{ title: '文案A' }, { title: '文案B' }] } };
      await assert.rejects(
        () => channel.listUserVideos('MS4wLjABAAAA_TEST', '0'),
        (err: Error) => err.name === 'ChannelError' && err.message.includes('2 条解析不出'),
      );
    });

    await t.test('部分条目解析不出 video_id → ChannelError（不静默丢弃）', async () => {
      payload = { data: { posts: [{ aweme_id: '7450000000000000001' }, { title: '文案B' }] } };
      await assert.rejects(
        () => channel.listUserVideos('MS4wLjABAAAA_TEST', '0'),
        (err: Error) => err.name === 'ChannelError' && err.message.includes('1 条解析不出'),
      );
    });

    await t.test('合法的空作品列表 → 正常返回 0 条，不报错', async () => {
      payload = { data: { posts: [], cursor: 0, has_more: false } };
      const result = await channel.listUserVideos('MS4wLjABAAAA_TEST', '0');
      assert.deepEqual(result.videos, []);
      assert.equal(result.hasMore, false);
    });

    await t.test('正常结构 → 3 条作品', async () => {
      payload = {
        data: {
          posts: [
            { aweme_id: '7450000000000000001', desc: 'A' },
            { aweme_id: '7450000000000000002', desc: 'B' },
            { aweme_id: '7450000000000000003', desc: 'C' },
          ],
          cursor: 0,
          has_more: false,
        },
      };
      const result = await channel.listUserVideos('MS4wLjABAAAA_TEST', '0');
      assert.deepEqual(result.videos.map((v) => v.videoId), [
        '7450000000000000001', '7450000000000000002', '7450000000000000003',
      ]);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

/**
 * 真机联调契约回归（依据 v5.1.7 源码 content.py / deps.py）：
 *  - cursor 是 opaque 值，第一页必须省略该参数，传 0 会被当成真实游标
 *  - 主鉴权头是 X-API-Key（Bearer 仅兼容），两个都要带
 */
test('DTK v5 契约：首屏省略 cursor、翻页带 cursor、鉴权头齐全', async () => {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { posts: [], cursor: 0, has_more: false } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  const cfg: AppConfig['dtk'] = {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'dtk_test_key',
    postsPath: '/api/v1/douyin/user/posts',
    videoPath: '/api/v1/douyin/video',
    taskPath: '/api/v1/tasks/{taskId}',
    postsUserParam: 'sec_user_id',
    postsCursorParam: 'cursor',
    postsCountParam: 'count',
    postsCount: 20,
    videoIdParam: 'aweme_id',
    syncWait: 25,
    timeoutMs: 5_000,
  };
  const channel = new Evil0ctalChannel(cfg);

  try {
    await channel.listUserVideos('MS4wLjABAAAA_TEST', '0');
    const first = seen[0]!;
    assert.ok(!first.url.includes('cursor='), '第一页不能带 cursor 参数');
    assert.ok(first.url.includes('sec_user_id=MS4wLjABAAAA_TEST'));
    assert.ok(first.url.includes('count=20'));
    assert.ok(first.url.includes('wait=25'));
    assert.equal(first.headers['x-api-key'], 'dtk_test_key');
    assert.equal(first.headers['authorization'], 'Bearer dtk_test_key');

    await channel.listUserVideos('MS4wLjABAAAA_TEST', 'next_cursor_123');
    assert.ok(seen[1]!.url.includes('cursor=next_cursor_123'), '翻页必须带上一页返回的 cursor');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
