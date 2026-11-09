/**
 * DTK v5 首次初始化 + API key 发放（全程 HTTP，不需要打开浏览器控制台）
 *
 *   npm run dtk:bootstrap                     # 自动从容器日志取 setup token
 *   npm run dtk:bootstrap -- --token xxxxx    # 手动指定 token
 *   npm run dtk:bootstrap -- --user admin --pass '你的密码'
 *
 * 流程：/readyz → /api/setup/status → (首次) /api/setup/init
 *       → /api/v1/auth/login → POST /api/v1/admin/api-keys
 *       → 把 key 写回 .env 的 DTK_API_KEY → 带 X-API-Key 验证一次
 *
 * 管理员凭据保存在 data/dtk-admin.json（已被 .gitignore 忽略），仅本机可读。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ quiet: true });

const BASE = (process.env['DTK_BASE_URL'] ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
const ENV_FILE = path.resolve('.env');
const STATE_FILE = path.resolve('data/dtk-admin.json');

interface Envelope {
  success?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string } | null;
}

function asRec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(body: Envelope, prefix: string): string {
  const err = body.error;
  return `${prefix}: ${err?.code ?? 'unknown'}${err?.message ? ` - ${err.message}` : ''}`;
}

async function call(pathname: string, init: RequestInit = {}): Promise<{ res: Response; body: Envelope }> {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body: Envelope = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text) as Envelope;
    } catch {
      throw new Error(`${pathname} 返回非 JSON: ${text.slice(0, 200)}`);
    }
  }
  return { res, body };
}

/** Node 的 set-cookie 可能是多个合并值，只取每段的第一对 key=value */
function cookieFrom(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((seg) => (seg.split(';')[0] ?? '').trim())
    .filter((seg) => seg.includes('='))
    .join('; ');
}

function tokenFromLogs(): string | undefined {
  const repo = process.env['DTK_REPO'] ?? path.resolve('..', 'douyin-api');
  const compose = path.join(repo, 'docker', 'compose.yml');
  if (!fs.existsSync(compose)) {
    console.warn(`未找到 ${compose}，无法自动提取 setup token，请用 --token 指定`);
    return undefined;
  }
  try {
    const out = execFileSync(
      'docker',
      ['compose', '-p', 'dtk', '-f', compose, 'logs', 'api', '--tail=300'],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return out.match(/\/setup\?token=([A-Za-z0-9_-]{8,})/)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * DTK v5 默认 security.request_proxy=deny，带 ?proxy= 的请求会被直接拒绝。
 * 机房 IP 部署且配置了住宅代理时，把它开到 public（只允许公网可路由地址，非 any）。
 * 失败不阻断初始化，但必须给出手动开启指引，否则后续所有轮询都会失败。
 */
async function ensureRequestProxy(cookie: string, proxyConfigured: boolean): Promise<void> {
  const KEY = 'security.request_proxy';
  try {
    const list = await call('/api/v1/admin/settings', { headers: { cookie } });
    if (!list.res.ok) throw new Error(`读取设置 HTTP ${list.res.status}`);
    const items = asRec(list.body.data)['settings'];
    const rows = Array.isArray(items) ? items.map(asRec) : [];
    const current = String(rows.find((r) => r['key'] === KEY)?.['value'] ?? '');

    if (!proxyConfigured) {
      if (current && current !== 'deny') {
        console.warn(`⚠️  未配置 DTK_PROXY_URL，但 ${KEY}=${current}；不用代理时建议改回 deny 以收窄 SSRF 面`);
      }
      return;
    }
    if (current === 'public' || current === 'any') {
      console.log(`✅ ${KEY} 已为 ${current}`);
      return;
    }
    const put = await call(`/api/v1/admin/settings/${KEY}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ value: 'public', confirm: true }),
    });
    if (!put.res.ok) throw new Error(`PUT 返回 HTTP ${put.res.status}: ${fail(put.body, '设置失败')}`);
    console.log(`✅ 已开启 ${KEY}=public（DTK 上游请求可走 ?proxy=，仅允许公网地址）`);
  } catch (err) {
    console.warn(`⚠️  无法自动设置 ${KEY}: ${(err as Error).message}`);
    if (proxyConfigured) {
      console.warn('   请在 DTK console → Settings 手动把 security.request_proxy 设为 public，');
      console.warn('   否则带 DTK_PROXY_URL 的采集请求会被 DTK 全部拒绝。');
    }
  }
}

function writeEnv(key: string): void {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`缺少 ${ENV_FILE}；请先 cp .env.example .env`);
  }
  const content = fs.readFileSync(ENV_FILE, 'utf8');
  const line = `DTK_API_KEY=${key}`;
  const updated = /^DTK_API_KEY=.*$/m.test(content)
    ? content.replace(/^DTK_API_KEY=.*$/m, line)
    : `${content.trimEnd()}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, updated);
  fs.chmodSync(ENV_FILE, 0o600);
}

function saveState(username: string, password: string): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ username, password, createdAt: new Date().toISOString() }, null, 2));
  fs.chmodSync(STATE_FILE, 0o600);
}

async function main(): Promise<void> {
  console.log(`DTK 实例: ${BASE}`);
  const health = await fetch(`${BASE}/readyz`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!health?.ok) {
    throw new Error(`容器未就绪（GET ${BASE}/readyz 失败）。先跑 npm run dtk:up，等 healthy 后重试`);
  }

  const status = await call('/api/setup/status');
  if (!status.res.ok) throw new Error(fail(status.body, '读取 setup 状态失败'));
  const initialized = Boolean(asRec(status.body.data)['initialized']);

  let username = arg('user') ?? process.env['DTK_ADMIN_USER'] ?? 'admin';
  let password = arg('pass') ?? process.env['DTK_ADMIN_PASSWORD'] ?? '';
  let generated = false;

  if (fs.existsSync(STATE_FILE)) {
    try {
      const saved = asRec(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
      if (!arg('pass') && !process.env['DTK_ADMIN_PASSWORD'] && typeof saved['password'] === 'string') {
        password = saved['password'];
        if (typeof saved['username'] === 'string') username = saved['username'];
      }
    } catch {
      console.warn(`${STATE_FILE} 解析失败，忽略`);
    }
  }

  if (initialized) {
    console.log('✅ 实例已初始化，跳过建管理员');
  } else {
    if (!password) {
      password = crypto.randomBytes(24).toString('base64url');
      generated = true;
    }
    const token = arg('token') ?? tokenFromLogs();
    if (!token) {
      throw new Error(
        '未拿到 setup token。执行 npm run dtk:logs 找到 /setup?token=... 后，' +
        '用 npm run dtk:bootstrap -- --token <token> 重试',
      );
    }
    const init = await call('/api/setup/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, username, password }),
    });
    if (!init.res.ok) throw new Error(fail(init.body, '创建管理员失败'));
    console.log(`✅ 管理员已创建: ${username}`);
    if (generated) {
      saveState(username, password);
      console.log(`   凭据已保存到 ${STATE_FILE}（一次性显示：${password}）`);
    }
  }

  if (!password) {
    throw new Error('实例已初始化但没有管理员密码；用 --pass 或环境变量 DTK_ADMIN_PASSWORD 提供');
  }

  const login = await call('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!login.res.ok) throw new Error(fail(login.body, '登录失败'));
  const cookie = cookieFrom(login.res);
  if (!cookie) throw new Error('登录成功但未拿到 session cookie，无法创建 API key');

  await ensureRequestProxy(cookie, Boolean(process.env['DTK_PROXY_URL']?.trim()));

  // 重跑 bootstrap（例如为了开启 ?proxy=）时不要重复发 key
  const existingKey = (process.env['DTK_API_KEY'] ?? '').trim();
  if (existingKey && !existingKey.includes('replace_me')) {
    try {
      const probe = await call('/api/v1/system/capabilities', { headers: { 'X-API-Key': existingKey } });
      if (probe.res.status !== 401) {
        console.log(`✅ 已有可用 API key，跳过重复创建（鉴权验证 HTTP ${probe.res.status}）`);
        return;
      }
    } catch { /* 探测失败按新建处理 */ }
  }

  const keyResp = await call('/api/v1/admin/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      name: `douyin-monitor-${new Date().toISOString().slice(0, 10)}`,
      scopes: ['douyin:read'],
      rate_limit: 120,
    }),
  });
  if (!keyResp.res.ok) throw new Error(fail(keyResp.body, '创建 API key 失败'));
  const key = String(asRec(keyResp.body.data)['key'] ?? '');
  if (!key) throw new Error('创建 API key 成功但响应里没有 key 字段');

  writeEnv(key);
  const verify = await call('/api/v1/system/capabilities', { headers: { 'X-API-Key': key } });
  if (verify.res.status === 401) throw new Error('API key 鉴权未通过（HTTP 401），请检查实例版本');

  console.log(`✅ API key 已写入 ${ENV_FILE}`);
  console.log(`   scope: douyin:read | 鉴权验证: HTTP ${verify.res.status}`);
  console.log('下一步：在 accounts.yaml 填真实 sec_user_id → npm run once -- --force');
}

main().catch((err: unknown) => {
  console.error(`\n❌ ${(err as Error).message}`);
  process.exitCode = 1;
});
