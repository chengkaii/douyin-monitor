/**
 * 一键演练：启动本地 mock DTK → 跑两轮采集 → 打印产物。
 * 零凭据、零 Docker、零真实账号，用来验证"发现 → 去重 → 下载 → manifest → 交付"全链路。
 * 用法：npm run demo
 */
import fs from 'node:fs';
import path from 'node:path';
import { startMockDtk } from './mock-dtk.js';
import { makeContext } from '../src/context.js';
import { runOnce } from '../src/pipeline.js';

const ROOT = process.cwd();
const DEMO_DIR = path.resolve(ROOT, 'data/demo');

function listFiles(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(path.join(dir, entry.name), rel)
      : [rel];
  });
}

async function main(): Promise<void> {
  fs.rmSync(DEMO_DIR, { recursive: true, force: true });
  fs.mkdirSync(DEMO_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DEMO_DIR, 'accounts.yaml'),
    'accounts:\n  - name: "示例账号A"\n    sec_user_id: "MS4wLjABAAAA_DEMO_USER"\n    enabled: true\n',
    'utf8',
  );

  const mock = await startMockDtk();
  const env = {
    ACCOUNTS_FILE: path.join(DEMO_DIR, 'accounts.yaml'),
    DB_PATH: path.join(DEMO_DIR, 'monitor.db'),
    TMP_DIR: path.join(DEMO_DIR, 'tmp'),
    OUTBOX_DIR: path.join(DEMO_DIR, 'outbox'),
    SINK: 'local',
    CHANNEL: 'evil0ctal',
    DTK_BASE_URL: mock.url,
    DTK_API_KEY: 'dtk_demo',
    DTK_POSTS_PATH: '/api/v1/demo/user-posts',
    DTK_POSTS_USER_PARAM: 'sec_user_id',
    DTK_POSTS_CURSOR_PARAM: 'cursor',
    DTK_POSTS_COUNT_PARAM: 'count',
    DTK_POSTS_COUNT: '20',
    DTK_VIDEO_PATH: '/api/v1/demo/video',
    DTK_VIDEO_ID_PARAM: 'aweme_id',
    DTK_TASK_PATH: '/api/v1/tasks/{taskId}',
    // 0 = 不带 wait，强制走 v5 的 202 + task_id 异步链路
    DTK_SYNC_WAIT: '0',
    DTK_TIMEOUT_MS: '15000',
    WECOM_WEBHOOK: '',
  };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  const ctx = makeContext();
  try {
    console.log(`\nmock DTK: ${mock.url}（异步 202 + task_id 模式）\n`);
    const first = await runOnce(ctx, { force: true });
    console.log('\n--- 第 1 轮 ---');
    console.log(`发现 ${first.discovered} 条 / 交付 ${first.uploaded} 条 / 失败 ${first.failed}`);
    for (const e of first.errors) console.log(`  ! ${e}`);

    const second = await runOnce(ctx, { force: true });
    console.log('\n--- 第 2 轮（验证去重）---');
    console.log(`发现 ${second.discovered} 条 / 交付 ${second.uploaded} 条 / 失败 ${second.failed}`);

    console.log('\n--- 产物 data/demo/outbox/ ---');
    for (const f of listFiles(path.join(DEMO_DIR, 'outbox'))) console.log(`  ${f}`);

    const ok = first.discovered === 3 && first.uploaded === 3
      && second.discovered === 0 && second.uploaded === 0
      && first.errors.length === 0 && second.errors.length === 0;
    console.log(`\n结果: ${ok ? '✅ 全链路通过' : '❌ 未达预期'}`);
    if (!ok) process.exitCode = 1;
  } finally {
    ctx.store.close();
    await mock.close();
  }
}

await main();
