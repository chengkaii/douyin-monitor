import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkLocal, exitCodeFor, renderChecks, summarize,
  EXIT_CONFIG, EXIT_OK, EXIT_UPSTREAM,
  type Check, type DoctorInput,
} from '../src/doctor.js';
import type { AppConfig } from '../src/types.js';

const SEC = 'MS4wLjABAAAAdu8I0mIDajXSXZZvtY79M';

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    accounts: [{ name: 'A', secUserId: SEC, enabled: true }],
    polling: {
      intervalMinutes: 5, jitterSeconds: 120, minGapSeconds: 8,
      nightIntervalMinutes: 15, nightStartHour: 0, nightEndHour: 6,
      timeZone: 'Asia/Shanghai',
    },
    download: { concurrency: 2, maxRetries: 3, minBytes: 1_048_576, retryDelaysMs: [30_000] },
    retry: { maxAttempts: 5, everyRounds: 20 },
    ossPrefix: 'douyin-monitor/',
    dtk: {
      baseUrl: 'http://127.0.0.1:8000', apiKey: 'dtk_abc_1234567890',
      postsPath: '/api/v1/douyin/user/posts', videoPath: '/api/v1/douyin/video',
      taskPath: '/api/v1/tasks/{taskId}', postsUserParam: 'sec_user_id',
      postsCursorParam: 'cursor', postsCountParam: 'count', postsCount: 20,
      videoIdParam: 'aweme_id', syncWait: 25, timeoutMs: 30_000, proxyUrl: '',
    },
    paths: { db: '/tmp/monitor.db', tmp: '/tmp/tmp', outbox: '/tmp/outbox', accounts: '/tmp/accounts.yaml' },
    sink: 'local',
    oss: {
      region: 'oss-cn-beijing', bucket: 'ffyc-creator',
      accessKeyId: '', accessKeySecret: '', prefix: 'douyin-monitor/',
    },
    wecomWebhook: '',
    ...over,
  };
}

function makeEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DTK_API_KEY: 'dtk_abc_1234567890',
    DTK_BASE_URL: 'http://127.0.0.1:8000',
    DTK_POSTS_PATH: '/api/v1/douyin/user/posts',
    DTK_VIDEO_PATH: '/api/v1/douyin/video',
    DTK_TASK_PATH: '/api/v1/tasks/{taskId}',
    WECOM_WEBHOOK: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx',
    ...over,
  };
}

function makeInput(over: Partial<DoctorInput> = {}): DoctorInput {
  return {
    envFileExists: true,
    accountsFileExists: true,
    env: makeEnv(),
    config: makeConfig(),
    nodeMajor: 22,
    writable: { 'DB 目录': true, 'TMP 目录': true, 'OUTBOX 目录': true },
    ...over,
  };
}

const errors = (checks: Check[]): Check[] => checks.filter((c) => c.level === 'error');
const warns = (checks: Check[]): Check[] => checks.filter((c) => c.level === 'warn');
const byLabel = (checks: Check[], label: string): Check | undefined => checks.find((c) => c.label === label);

test('基线配置：0 个本地错误，只有「演练模式」警告', () => {
  const s = summarize(checkLocal(makeInput()));
  assert.equal(s.localErrors, 0);
  assert.equal(s.upstreamErrors, 0);
  assert.equal(s.warnings, 1);
  assert.equal(byLabel(checkLocal(makeInput()), '交付模式')?.level, 'warn');
});

test('缺 .env / accounts.yaml 归为本地配置错误，并给出修复命令', () => {
  const checks = checkLocal(makeInput({ envFileExists: false, accountsFileExists: false }));
  assert.equal(byLabel(checks, '.env 文件')?.level, 'error');
  assert.equal(byLabel(checks, 'accounts.yaml')?.level, 'error');
  assert.match(byLabel(checks, '.env 文件')?.hint ?? '', /cp \.env\.example/);
  assert.match(byLabel(checks, 'accounts.yaml')?.hint ?? '', /add-account/);
});

test('API key 为空或占位值都判错', () => {
  for (const key of ['', 'dtk_replace_me']) {
    const checks = checkLocal(makeInput({ env: makeEnv({ DTK_API_KEY: key }) }));
    assert.equal(byLabel(checks, 'DTK_API_KEY')?.level, 'error', `key=${key}`);
    assert.match(byLabel(checks, 'DTK_API_KEY')?.hint ?? '', /dtk:bootstrap/);
  }
});

test('loadConfig 抛错时单独列一条「配置加载」错误', () => {
  const checks = checkLocal(makeInput({ config: null, configError: '缺少 accounts.yaml' }));
  assert.equal(byLabel(checks, '配置加载')?.level, 'error');
  assert.match(byLabel(checks, '配置加载')?.detail ?? '', /缺少 accounts.yaml/);
});

test('0 个账号 / 短链未转换 / 全禁用 三种账号问题分别识别', () => {
  assert.equal(byLabel(checkLocal(makeInput({ config: makeConfig({ accounts: [] }) })), '监测账号')?.level, 'error');

  const shortLink = checkLocal(makeInput({
    config: makeConfig({ accounts: [{ name: 'A', secUserId: 'https://v.douyin.com/abc/', enabled: true }] }),
  }));
  assert.equal(byLabel(shortLink, '监测账号')?.level, 'error');
  assert.match(byLabel(shortLink, '监测账号')?.hint ?? '', /add-account/);

  const disabled = checkLocal(makeInput({
    config: makeConfig({ accounts: [{ name: 'A', secUserId: SEC, enabled: false }] }),
  }));
  assert.equal(byLabel(disabled, '账号启用状态')?.level, 'warn');
});

test('SINK=oss 缺凭据判错；SINK=local 明确提示是演练', () => {
  const oss = checkLocal(makeInput({ config: makeConfig({ sink: 'oss' }) }));
  assert.equal(byLabel(oss, 'OSS 凭据')?.level, 'error');
  assert.match(byLabel(oss, 'OSS 凭据')?.detail ?? '', /OSS_ACCESS_KEY_ID/);

  const ready = checkLocal(makeInput({
    config: makeConfig({
      sink: 'oss',
      oss: {
        region: 'oss-cn-beijing', bucket: 'ffyc-creator',
        accessKeyId: 'AK', accessKeySecret: 'SK', prefix: 'douyin-monitor/',
      },
    }),
  }));
  assert.equal(byLabel(ready, 'OSS 凭据')?.level, 'ok');
});

test('非法时区 / 目录不可写 / Node 过旧 / 无企微 都单独列出', () => {
  assert.equal(byLabel(checkLocal(makeInput({
    config: makeConfig({ polling: { ...makeConfig().polling, timeZone: 'Mars/Phobos' } }),
  })), '夜间时区')?.level, 'error');

  const unwritable = checkLocal(makeInput({ writable: { 'DB 目录': false } }));
  assert.equal(byLabel(unwritable, '目录可写')?.level, 'error');

  assert.equal(byLabel(checkLocal(makeInput({ nodeMajor: 18 })), 'Node 版本')?.level, 'error');
  assert.equal(byLabel(checkLocal(makeInput({ env: makeEnv({ WECOM_WEBHOOK: '' }) })), '企微告警')?.level, 'warn');
});

test('退出码：本地错=2，仅上游错=3，全绿=0，警告不影响', () => {
  const ok: Check[] = [{ level: 'ok', group: 'local', label: 'A', detail: 'ok' }];
  const warn: Check[] = [{ level: 'warn', group: 'local', label: 'B', detail: 'w' }];
  const localErr: Check[] = [{ level: 'error', group: 'local', label: 'C', detail: 'e' }];
  const upErr: Check[] = [{ level: 'error', group: 'upstream', label: 'D', detail: 'e' }];

  assert.equal(exitCodeFor([...ok, ...warn]), EXIT_OK);
  assert.equal(exitCodeFor([...ok, ...localErr, ...upErr]), EXIT_CONFIG, '本地错误优先');
  assert.equal(exitCodeFor([...ok, ...upErr]), EXIT_UPSTREAM);
  assert.equal(EXIT_CONFIG, 2);
  assert.equal(EXIT_UPSTREAM, 3);
});

test('渲染按本地/上游分组，错误带提示行，结论能区分两类故障', () => {
  const checks: Check[] = [
    { level: 'error', group: 'local', label: 'API Key', detail: '未填写', hint: '跑 bootstrap' },
    { level: 'ok', group: 'upstream', label: '实例可达', detail: '正常' },
  ];
  const text = renderChecks(checks);
  assert.match(text, /=== 本地配置 ===/);
  assert.match(text, /=== 上游 DTK ===/);
  assert.match(text, /→ 跑 bootstrap/);
  assert.match(text, /配置错误 1 \/ 上游故障 0/);
  assert.match(text, /本地配置问题/);

  const upstreamOnly = renderChecks([
    { level: 'ok', group: 'local', label: 'A', detail: 'ok' },
    { level: 'error', group: 'upstream', label: '实例可达', detail: '超时' },
  ]);
  assert.match(upstreamOnly, /问题在 DTK 实例/);
});
