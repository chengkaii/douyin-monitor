/**
 * doctor 自检：把「本地配错了」和「上游坏掉了」彻底分开。
 *
 * 借鉴 42419/douyin-monitor 的 `dywatch doctor`：启动前用零成本检查定位问题，
 * 别等真跑起来才发现「是 Key 没填」还是「DTK 挂了」。
 * 这里只做纯判断与渲染，网络探测在 scripts/doctor.ts，两者结果合成同一份 Check[]。
 */
import { isSecUid } from './secuid.js';
import type { AppConfig } from './types.js';

export type CheckLevel = 'ok' | 'warn' | 'error';
export type CheckGroup = 'local' | 'upstream';

export interface Check {
  level: CheckLevel;
  group: CheckGroup;
  label: string;
  detail: string;
  hint?: string;
}

export interface DoctorInput {
  envFileExists: boolean;
  accountsFileExists: boolean;
  env: Record<string, string | undefined>;
  config: AppConfig | null;
  configError?: string;
  nodeMajor: number;
  /** 目录名 → 是否可写 */
  writable: Record<string, boolean>;
}

/** 退出码：0 通过 / 2 本地配置错误 / 3 上游故障（对齐 systemd RestartPreventExitStatus 思路） */
export const EXIT_OK = 0;
export const EXIT_CONFIG = 2;
export const EXIT_UPSTREAM = 3;

const PLACEHOLDER_RE = /replace_me/i;

export function checkLocal(input: DoctorInput): Check[] {
  const { env, config } = input;
  const checks: Check[] = [];
  const add = (
    level: CheckLevel,
    label: string,
    detail: string,
    hint?: string,
  ): void => {
    checks.push({ level, group: 'local', label, detail, ...(hint ? { hint } : {}) });
  };

  add(
    input.nodeMajor >= 20 ? 'ok' : 'error',
    'Node 版本',
    `v${input.nodeMajor}`,
    input.nodeMajor >= 20 ? undefined : '需要 Node ≥ 20（依赖 node:sqlite / fetch / AbortSignal.timeout）',
  );

  add(
    input.envFileExists ? 'ok' : 'error',
    '.env 文件',
    input.envFileExists ? '存在' : '不存在',
    input.envFileExists ? undefined : 'cp .env.example .env',
  );

  add(
    input.accountsFileExists ? 'ok' : 'error',
    'accounts.yaml',
    input.accountsFileExists ? '存在' : '不存在',
    input.accountsFileExists ? undefined : 'cp accounts.example.yaml accounts.yaml，或用 npm run add-account -- "<主页链接>"',
  );

  if (input.configError || !config) {
    add('error', '配置加载', input.configError ?? 'loadConfig 未返回配置', '按报错补齐 .env / accounts.yaml 后重试');
  } else {
    add('ok', '配置加载', '解析通过');
  }

  const apiKey = (env['DTK_API_KEY'] ?? '').trim();
  if (!apiKey || PLACEHOLDER_RE.test(apiKey)) {
    add('error', 'DTK_API_KEY', !apiKey ? '未填写' : '仍是示例占位值', 'npm run dtk:bootstrap 生成并写回 .env');
  } else {
    add('ok', 'DTK_API_KEY', `已配置（${apiKey.slice(0, 7)}…）`);
  }

  const baseUrl = (env['DTK_BASE_URL'] ?? config?.dtk.baseUrl ?? 'http://127.0.0.1:8000').trim();
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 http/https');
    add('ok', 'DTK_BASE_URL', baseUrl);
  } catch {
    add('error', 'DTK_BASE_URL', `不是合法 URL：${baseUrl}`, '例：http://127.0.0.1:8000');
  }

  const paths: Array<[string, string]> = config
    ? [
        ['DTK_POSTS_PATH', config.dtk.postsPath],
        ['DTK_VIDEO_PATH', config.dtk.videoPath],
        ['DTK_TASK_PATH', config.dtk.taskPath],
      ]
    : [
        ['DTK_POSTS_PATH', env['DTK_POSTS_PATH'] ?? ''],
        ['DTK_VIDEO_PATH', env['DTK_VIDEO_PATH'] ?? ''],
        ['DTK_TASK_PATH', env['DTK_TASK_PATH'] ?? ''],
      ];
  const missingPaths = paths.filter(([, v]) => !v.trim()).map(([k]) => k);
  add(
    missingPaths.length > 0 ? 'error' : 'ok',
    'DTK 接口路径',
    missingPaths.length > 0 ? `缺少 ${missingPaths.join(' / ')}` : '列表 / 详情 / 任务三项均已配置',
    missingPaths.length > 0 ? 'npm run inspect-openapi 核对实例版本后填进 .env' : undefined,
  );

  if (config) {
    const accounts = config.accounts;
    if (accounts.length === 0) {
      add('error', '监测账号', '0 个', 'npm run add-account -- "<主页链接>" 添加账号');
    } else {
      const bad = accounts.filter((a) => PLACEHOLDER_RE.test(a.secUserId) || !isSecUid(a.secUserId));
      if (bad.length > 0) {
        add(
          'error',
          '监测账号',
          `${accounts.length} 个，其中 ${bad.length} 个 sec_user_id 不合法：${bad.map((a) => a.name).join('、')}`,
          '短链需先转换：npm run add-account -- "<短链>"；或改用 /user/ 主页链接',
        );
      } else {
        const enabled = accounts.filter((a) => a.enabled).length;
        add('ok', '监测账号', `${accounts.length} 个（启用 ${enabled} 个）`);
        if (enabled === 0) add('warn', '账号启用状态', '全部为 enabled: false，serve 不会轮询任何账号');
      }
    }

    if (config.sink === 'oss') {
      const missing = [
        !config.oss.accessKeyId ? 'OSS_ACCESS_KEY_ID' : '',
        !config.oss.accessKeySecret ? 'OSS_ACCESS_KEY_SECRET' : '',
        !config.oss.bucket ? 'OSS_BUCKET' : '',
        !config.oss.region ? 'OSS_REGION' : '',
      ].filter(Boolean);
      add(
        missing.length > 0 ? 'error' : 'ok',
        'OSS 凭据',
        missing.length > 0 ? `缺少 ${missing.join(' / ')}` : 'SINK=oss，凭据齐全',
      );
    } else {
      add('warn', '交付模式', 'SINK=local（演练）', '正式交付需设 SINK=oss 并填 OSS_* 凭据，产物目前只写 data/outbox/');
    }

    try {
      new Intl.DateTimeFormat('en-US', { timeZone: config.polling.timeZone, hour: 'numeric' }).format(new Date());
      add('ok', '夜间时区', config.polling.timeZone);
    } catch {
      add('error', '夜间时区', `非法时区 ${config.polling.timeZone}`, '例：Asia/Shanghai');
    }
  }

  for (const [dir, ok] of Object.entries(input.writable)) {
    add(ok ? 'ok' : 'error', '目录可写', `${dir}: ${ok ? '可写' : '不可写'}`, ok ? undefined : '检查属主与权限，或换 DB_PATH / TMP_DIR / OUTBOX_DIR');
  }

  if (!(env['WECOM_WEBHOOK'] ?? '').trim()) {
    add('warn', '企微告警', '未配置 WECOM_WEBHOOK', '告警只会写 run_log / journald，生产建议配上');
  } else {
    add('ok', '企微告警', '已配置');
  }

  return checks;
}

export function summarize(checks: Check[]): {
  localErrors: number;
  upstreamErrors: number;
  warnings: number;
  oks: number;
} {
  const count = (level: CheckLevel, group?: CheckGroup): number =>
    checks.filter((c) => c.level === level && (group === undefined || c.group === group)).length;
  return {
    localErrors: count('error', 'local'),
    upstreamErrors: count('error', 'upstream'),
    warnings: count('warn'),
    oks: count('ok'),
  };
}

export function exitCodeFor(checks: Check[]): number {
  const s = summarize(checks);
  if (s.localErrors > 0) return EXIT_CONFIG;
  if (s.upstreamErrors > 0) return EXIT_UPSTREAM;
  return EXIT_OK;
}

const ICON: Record<CheckLevel, string> = { ok: '✅', warn: '⚠️ ', error: '❌' };

/** 按 local / upstream 分组渲染，错误项紧跟一行可操作提示 */
export function renderChecks(checks: Check[]): string {
  const out: string[] = [];
  for (const [group, title] of [['local', '本地配置'], ['upstream', '上游 DTK']] as const) {
    const rows = checks.filter((c) => c.group === group);
    if (rows.length === 0) continue;
    out.push(`\n=== ${title} ===`);
    for (const c of rows) {
      out.push(`  ${ICON[c.level]} ${c.label.padEnd(14)} ${c.detail}`);
      if (c.hint) out.push(`     → ${c.hint}`);
    }
  }
  const s = summarize(checks);
  out.push('\n=== 结论 ===');
  out.push(`  配置错误 ${s.localErrors} / 上游故障 ${s.upstreamErrors} / 警告 ${s.warnings} / 通过 ${s.oks}`);
  if (s.localErrors > 0) out.push('  诊断：本地配置问题，修好 .env / accounts.yaml 即可，不必排查 DTK 容器。');
  else if (s.upstreamErrors > 0) out.push('  诊断：本地配置正常，问题在 DTK 实例 / 凭据 / 账号权限。');
  else out.push('  诊断：自检通过，可以 npm run once -- --force 试跑。');
  return out.join('\n');
}
