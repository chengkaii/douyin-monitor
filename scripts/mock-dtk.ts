/**
 * 本地 mock DTK v5 服务：零凭据、零 Docker 也能跑通全链路。
 *  - GET /openapi.json                      模拟实例接口清单
 *  - GET /api/v1/demo/user-posts            账号作品列表（?cursor=0）
 *  - GET /api/v1/demo/video                 单视频详情（含无水印播放地址）
 *  - GET /api/v1/tasks/{taskId}             异步任务结果
 *  - GET /media/{id}.mp4                    1.2MB 假视频，供下载器校验
 * 不带 wait 参数时返回 202 + task_id，用来验证 Channel 的异步收敛逻辑。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const VIDEO_IDS = ['7450000000000000001', '7450000000000000002', '7450000000000000003'];
const NOW_SEC = Math.floor(Date.now() / 1000);

export interface MockServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function postsPayload(): Record<string, unknown> {
  return {
    data: {
      posts: VIDEO_IDS.map((id, i) => ({
        aweme_id: id,
        desc: `示例文案 ${i + 1} #短剧 #创作营`,
        create_time: NOW_SEC - i * 3600,
        author: { nickname: '示例账号A', signature: 'mock' },
        statistics: { digg_count: 100 + i, comment_count: 10 + i, share_count: i },
        share_url: `https://www.douyin.com/video/${id}`,
      })),
      cursor: 0,
      has_more: false,
    },
  };
}

function videoPayload(id: string): Record<string, unknown> {
  return {
    data: {
      aweme_detail: {
        aweme_id: id,
        desc: `示例文案 ${id.slice(-1)} #短剧 #创作营`,
        create_time: NOW_SEC,
        author: { nickname: '示例账号A', signature: 'mock' },
        statistics: { digg_count: 100, comment_count: 10, share_count: 1 },
        video: {
          play_addr: {
            url_list: [`http://127.0.0.1:PORT/media/${id}.mp4`],
          },
        },
      },
    },
  };
}

export async function startMockDtk(preferredPort = 8787): Promise<MockServer> {
  const tasks = new Map<string, unknown>();
  const videoBody = Buffer.alloc(1024 * 1024 + 512, 0);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const port = (server.address() as AddressInfo | null)?.port ?? preferredPort;
    const send = (status: number, payload: unknown, type = 'application/json'): void => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    };

    if (url.pathname === '/openapi.json') {
      send(200, {
        paths: {
          '/api/v1/demo/user-posts': { get: { summary: "An author's posts", parameters: [{ name: 'sec_user_id' }, { name: 'cursor' }, { name: 'count' }, { name: 'wait' }] } },
          '/api/v1/demo/video': { get: { summary: 'One post by id', parameters: [{ name: 'aweme_id' }, { name: 'wait' }] } },
          '/api/v1/tasks/{taskId}': { get: { summary: 'Task result', parameters: [] } },
        },
      });
      return;
    }

    if (url.pathname.startsWith('/media/')) {
      send(200, videoBody, 'video/mp4');
      return;
    }

    if (url.pathname.startsWith('/api/v1/tasks/')) {
      const taskId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      const result = tasks.get(taskId);
      if (result === undefined) { send(404, { error: 'task not found' }); return; }
      send(200, { status: 'succeeded', result });
      return;
    }

    let payload: Record<string, unknown> | undefined;
    if (url.pathname === '/api/v1/demo/user-posts') payload = postsPayload();
    if (url.pathname === '/api/v1/demo/video') {
      payload = videoPayload(url.searchParams.get('aweme_id') ?? VIDEO_IDS[0]!);
    }
    if (!payload) { send(404, { error: 'not found' }); return; }

    // 详情里的播放地址带上真实端口
    const fixed = JSON.parse(JSON.stringify(payload).replace(/PORT/g, String(port))) as Record<string, unknown>;

    if (!url.searchParams.has('wait')) {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      tasks.set(taskId, fixed);
      send(202, { task_id: taskId, status: 'queued' });
      return;
    }
    send(200, fixed);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(preferredPort, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const mock = await startMockDtk();
  console.log(`mock DTK 已启动: ${mock.url}`);
  console.log('另开终端设置 DTK_BASE_URL 后运行 npm run once，或直接用 npm run demo');
}
