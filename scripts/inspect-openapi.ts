/**
 * 从运行中的 DTK v5 实例拉取 /openapi.json，筛出"用户作品列表 / 单视频 / 任务状态"的候选接口。
 * 用法：npm run inspect-openapi
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv({ quiet: true });
const base = (process.env['DTK_BASE_URL'] ?? 'http://127.0.0.1:8000').replace(/\/$/, '');

const KEYWORDS = /post|user|author|video|aweme|task|detail|作品|视频/i;

interface Operation {
  method: string;
  path: string;
  summary: string;
  params: string[];
}

async function main(): Promise<void> {
  let doc: Record<string, unknown>;
  try {
    const res = await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error(`无法读取 ${base}/openapi.json: ${(err as Error).message}`);
    console.error('先确认容器已启动：npm run dtk:status');
    process.exit(1);
  }

  const paths = (doc['paths'] ?? {}) as Record<string, Record<string, unknown>>;
  const ops: Operation[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, raw] of Object.entries(methods)) {
      if (!['get', 'post'].includes(method.toLowerCase())) continue;
      const item = (raw ?? {}) as Record<string, unknown>;
      const summary = String(item['summary'] ?? item['operationId'] ?? '');
      const params = Array.isArray(item['parameters'])
        ? (item['parameters'] as Array<Record<string, unknown>>)
            .map((p) => String(p['name'] ?? ''))
            .filter(Boolean)
        : [];
      ops.push({ method: method.toUpperCase(), path, summary, params });
    }
  }

  const candidates = ops.filter((o) => KEYWORDS.test(`${o.path} ${o.summary} ${o.params.join(' ')}`));
  console.log(`\nDTK 实例: ${base}`);
  console.log(`共 ${ops.length} 个 GET/POST 接口，其中 ${candidates.length} 个与采集相关：\n`);
  for (const o of candidates) {
    console.log(`${o.method.padEnd(5)} ${o.path}`);
    if (o.summary) console.log(`      ${o.summary}`);
    if (o.params.length) console.log(`      参数: ${o.params.join(', ')}`);
  }

  console.log('\n把下面几项填进 .env 后即可跑 npm run once：');
  console.log('  DTK_POSTS_PATH / DTK_POSTS_USER_PARAM / DTK_POSTS_CURSOR_PARAM / DTK_POSTS_COUNT_PARAM');
  console.log('  DTK_VIDEO_PATH / DTK_VIDEO_ID_PARAM');
  console.log('  DTK_TASK_PATH（若接口默认返回 202）\n');
}

await main();
