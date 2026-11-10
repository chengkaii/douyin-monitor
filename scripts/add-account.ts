/**
 * 账号录入 CLI：粘链接/分享文案/ sec_user_id 都行，自动写回 accounts.yaml。
 *
 *   npm run add-account -- "<主页链接或分享文案>"
 *   npm run add-account -- "https://v.douyin.com/xxxxx/" --name 某某
 *
 * 纯本地正则能命中就不碰网络；只有短链才发 HEAD 跟重定向。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { resolveSecUid } from '../src/secuid.js';
import { upsertAccountText } from '../src/account-file.js';

loadDotenv({ quiet: true });

const ACCOUNTS_FILE = path.resolve(process.env['ACCOUNTS_FILE'] ?? './accounts.yaml');
const TEMPLATE_FILE = path.resolve('accounts.example.yaml');

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function autoName(text: string): string {
  const used = new Set(
    [...text.matchAll(/name:\s*["']?(账号\d+)/g)].map((m) => m[1]).filter(Boolean),
  );
  let i = 1;
  while (used.has(`账号${i}`)) i += 1;
  return `账号${i}`;
}

function usage(): void {
  console.log(`用法：
  npm run add-account -- "<主页链接 / 分享文案 / 短链 / sec_user_id>" [--name 昵称]

支持：
  MS4wLjABAAAA...                          纯 sec_user_id
  https://www.douyin.com/user/MS4w...      主页链接
  https://v.douyin.com/xxxxx/              短链（HEAD 跟重定向）
  长按复制此条消息… https://v.douyin.com/…  整段分享文案

账号写入 ${ACCOUNTS_FILE}；重复 sec_user_id 自动跳过，模板占位账号自动清除。`);
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw || raw.startsWith('--')) {
    usage();
    process.exitCode = 2;
    return;
  }

  if (raw.includes('v.douyin.com')) console.log('正在解析短链重定向…');
  const result = await resolveSecUid(raw);
  if (!result.secUid) {
    console.error(`❌ ${result.error ?? '无法从输入中解析出 sec_user_id'}`);
    console.error('   可改用「抖音 App → 主页 → 分享 → 复制链接 → 浏览器打开」后的 /user/ 完整地址。');
    process.exitCode = 2;
    return;
  }

  if (!fs.existsSync(ACCOUNTS_FILE)) {
    if (!fs.existsSync(TEMPLATE_FILE)) {
      console.error(`❌ 缺少 ${TEMPLATE_FILE}，无法初始化账号清单`);
      process.exitCode = 2;
      return;
    }
    console.log(`未找到 accounts.yaml，已从模板初始化：${ACCOUNTS_FILE}`);
  }

  const original = fs.existsSync(ACCOUNTS_FILE)
    ? fs.readFileSync(ACCOUNTS_FILE, 'utf8')
    : fs.readFileSync(TEMPLATE_FILE, 'utf8');
  const name = argValue('name') ?? autoName(original);
  const { text, added, reason } = upsertAccountText(original, result.secUid, name);

  if (!added) {
    console.log(`⏭️  ${reason ?? '账号已存在'}：${result.secUid}`);
    return;
  }

  fs.writeFileSync(ACCOUNTS_FILE, text, 'utf8');
  console.log(`✅ 已添加 ${name}  ${result.secUid}  （来源：${result.source}）`);
  console.log(`   文件：${ACCOUNTS_FILE}`);
  console.log('下一步：npm run doctor 自检 → npm run once -- --force 试跑一轮');
}

await main();
