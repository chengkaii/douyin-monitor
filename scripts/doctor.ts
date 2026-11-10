/**
 * doctor 自检 CLI（上线前 / 排障时第一条命令）
 *
 *   npm run doctor                     # 本地配置 + readyz + 鉴权 + 首个账号可读性
 *   npm run doctor -- --all-accounts  # 逐个验证所有账号（每个消耗 1 个身份租约）
 *   npm run doctor -- --no-probe      # 只查本地配置，完全不碰上游
 *
 * 退出码：0 通过 / 2 本地配置错误 / 3 上游故障。
 * 本地有错时直接返回，不再探测上游——避免把「Key 没填」误报成一串网络错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '../src/config.js';
import { createChannel } from '../src/channel/index.js';
import {
  checkLocal, exitCodeFor, renderChecks,
  type Check,
} from '../src/doctor.js';
import type { AppConfig } from '../src/types.js';

const ENV_FILE = path.resolve('.env');

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function isWritableDir(target: string): boolean {
  let cur = path.resolve(target);
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  try {
    fs.accessSync(cur, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function ok(group: Check['group'], label: string, detail: string, hint?: string): Check {
  return { level: 'ok', group, label, detail, ...(hint ? { hint } : {}) };
}
function warn(group: Check['group'], label: string, detail: string, hint?: string): Check {
  return { level: 'warn', group, label, detail, ...(hint ? { hint } : {}) };
}
function fail(group: Check['group'], label: string, detail: string, hint?: string): Check {
  return { level: 'error', group, label, detail, ...(hint ? { hint } : {}) };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** 上游探测：readyz → 鉴权 → 账号可读性；任一硬失败立即停止，不刷屏 */
async function probeUpstream(config: AppConfig, allAccounts: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  const base = config.dtk.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-API-Key': config.dtk.apiKey,
  };

  try {
    const res = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    checks.push(ok('upstream', '实例可达', `${base}/readyz 正常`));
  } catch (err) {
    checks.push(fail('upstream', '实例可达', `${base} 不可达: ${(err as Error).message}`,
      'npm run dtk:status 看容器健康；未起栈用 npm run dtk:up'));
    return checks;
  }

  try {
    const res = await fetch(`${base}/api/v1/auth/me`, {
      headers, signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403) {
      checks.push(fail('upstream', 'API Key', `鉴权被拒（HTTP ${res.status}）`,
        'Key 无效或缺 scope；npm run dtk:bootstrap 重发一把'));
      return checks;
    }
    if (res.status === 404) {
      // 老版本没有 /auth/me，退回 bootstrap 用的零成本探针
      const alt = await fetch(`${base}/api/v1/system/capabilities`, {
        headers, signal: AbortSignal.timeout(8_000),
      });
      if (alt.status === 401 || alt.status === 403) {
        checks.push(fail('upstream', 'API Key', `鉴权被拒（HTTP ${alt.status}）`,
          'npm run dtk:bootstrap 重发一把 Key'));
        return checks;
      }
      checks.push(alt.ok
        ? ok('upstream', 'API Key', '鉴权通过（/system/capabilities）')
        : warn('upstream', 'API Key', `自检端点返回 HTTP ${alt.status}`, '实例版本差异，不阻断；用 npm run inspect-openapi 核对'));
    } else if (res.ok) {
      const body = asRecord(await res.json().catch(() => ({})));
      const data = asRecord(body['data'] ?? body);
      const scopes = Array.isArray(data['scopes']) ? (data['scopes'] as unknown[]).join(', ') : '';
      checks.push(ok('upstream', 'API Key', `鉴权通过${scopes ? `（scope: ${scopes}）` : ''}`));
    } else {
      checks.push(fail('upstream', 'API Key', `自检返回 HTTP ${res.status}`, '检查 DTK 日志与实例版本'));
      return checks;
    }
  } catch (err) {
    checks.push(fail('upstream', 'API Key', `鉴权探测失败: ${(err as Error).message}`));
    return checks;
  }

  const enabled = config.accounts.filter((a) => a.enabled);
  const targets = allAccounts ? enabled : enabled.slice(0, 1);
  if (targets.length === 0) {
    checks.push(warn('upstream', '账号可读性', '没有启用的账号，跳过探测'));
    return checks;
  }

  const channel = createChannel(config);
  for (const account of targets) {
    try {
      const page = await channel.listUserVideos(account.secUserId, '');
      if (page.videos.length === 0) {
        checks.push(warn('upstream', '账号可读性', `${account.name}: 返回合法空列表`,
          '可能是新账号；若历史有作品，重点排查登录态过期 / 游客视角 / 接口权限'));
      } else {
        checks.push(ok('upstream', '账号可读性', `${account.name}: 读到 ${page.videos.length} 条作品`));
      }
    } catch (err) {
      checks.push(fail('upstream', '账号可读性', `${account.name}: ${(err as Error).message}`,
        '核对 sec_user_id、Key scope、DTK 登录态与住宅代理'));
    }
  }
  if (!allAccounts && enabled.length > 1) {
    checks.push(ok('upstream', '账号可读性', `仅验证首个账号，其余 ${enabled.length - 1} 个用 --all-accounts 逐个检查`));
  }
  return checks;
}

async function main(): Promise<void> {
  const envFileExists = fs.existsSync(ENV_FILE);
  loadDotenv({ path: ENV_FILE, quiet: true });
  const accountsFile = path.resolve(process.env['ACCOUNTS_FILE'] ?? './accounts.yaml');
  const accountsFileExists = fs.existsSync(accountsFile);

  let config: AppConfig | null = null;
  let configError: string | undefined;
  try {
    config = loadConfig();
  } catch (err) {
    configError = (err as Error).message;
  }

  const env = process.env as Record<string, string | undefined>;
  const writable = {
    'DB 目录': isWritableDir(path.dirname(path.resolve(env['DB_PATH'] ?? './data/monitor.db'))),
    'TMP 目录': isWritableDir(path.resolve(env['TMP_DIR'] ?? './data/tmp')),
    'OUTBOX 目录': isWritableDir(path.resolve(env['OUTBOX_DIR'] ?? './data/outbox')),
  };

  const checks: Check[] = checkLocal({
    envFileExists,
    accountsFileExists,
    env,
    config,
    ...(configError ? { configError } : {}),
    nodeMajor: Number(process.versions.node.split('.')[0] ?? 0),
    writable,
  });

  console.log(`\n抖音采集自检 · ${config?.dtk.baseUrl ?? env['DTK_BASE_URL'] ?? 'http://127.0.0.1:8000'}`);

  const localErrors = checks.filter((c) => c.level === 'error' && c.group === 'local').length;
  if (localErrors === 0 && config && !flag('no-probe')) {
    if (!flag('all-accounts')) console.log('（账号探测默认只跑首个，会消耗 1 个身份租约）');
    checks.push(...await probeUpstream(config, flag('all-accounts')));
  } else if (flag('no-probe')) {
    console.log('（--no-probe：跳过全部上游探测）');
  }

  console.log(renderChecks(checks));
  process.exitCode = exitCodeFor(checks);
}

await main();
