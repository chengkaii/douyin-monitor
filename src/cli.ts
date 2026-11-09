import { makeContext } from './context.js';
import { runOnce, runForever, type PipelineContext } from './pipeline.js';

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function printStatus(ctx: PipelineContext): void {
  const stats = ctx.store.stats();
  console.log('\n=== 抖音采集状态 ===');
  console.log(`通道     : ${ctx.channel.name}`);
  console.log(`交付     : ${ctx.sink.name}`);
  console.log(`已见视频 : ${stats.total}（今日新增 ${stats.today}）`);
  console.log(`待处理   : ${stats.queueDepth}`);
  const failedRows = ctx.store.listByStatus('failed');
  const retryable = failedRows.filter((r) => r.attempts < ctx.config.retry.maxAttempts).length;
  console.log(`失败     : ${failedRows.length}（可自动重投 ${retryable} / 已达上限 ${failedRows.length - retryable}）`);
  for (const row of stats.byStatus) console.log(`  ${row.status.padEnd(12)} ${row.count}`);
  console.log('\n账号轮询状态:');
  for (const a of ctx.config.accounts) {
    const s = ctx.store.getPollState(a.secUserId);
    const next = s ? new Date(s.next_poll_at).toLocaleString('zh-CN') : '尚未轮询';
    console.log(`  ${a.enabled ? '●' : '○'} ${a.name.padEnd(16)} 下次 ${next}  连续失败 ${s?.fail_streak ?? 0}`);
  }
  console.log('\n最近日志:');
  for (const l of ctx.store.recentLogs(10)) {
    console.log(`  ${new Date(l.ts).toLocaleTimeString('zh-CN')} [${l.level}] ${l.scope}: ${l.message}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'once';
  // status 允许在没有 accounts.yaml 时查看库状态；且只读命令不触发任务恢复，
  // 避免 serve 正在下载时把它的 downloading 行抢走重复处理
  const isReadOnly = command === 'status';
  const ctx = makeContext(!isReadOnly, { recover: !isReadOnly });

  try {
    switch (command) {
      case 'once': {
        if (ctx.config.accounts.length === 0) {
          console.log('没有启用的账号。请复制 accounts.example.yaml 为 accounts.yaml 并填写 sec_user_id。');
          break;
        }
        const summary = await runOnce(ctx, {
          force: argFlag('force'),
          accountName: argValue('account'),
          includeFailed: argFlag('retry-failed'),
        });
        console.log('\n=== 本轮结果 ===');
        console.log(`轮询账号 : ${summary.polled.join(', ') || '无（未到期，用 --force 强制）'}`);
        console.log(`新增发现 : ${summary.discovered}`);
        console.log(`成功交付 : ${summary.uploaded}`);
        console.log(`失败     : ${summary.failed}`);
        for (const e of summary.errors) console.log(`  ! ${e}`);
        break;
      }
      case 'retry-failed': {
        // --force 突破 attempts 上限，用于人工确认故障已恢复后重投已耗尽的行
        const summary = await runOnce(ctx, { includeFailed: true, ignoreRetryCap: argFlag('force') });
        console.log(`补传完成：成功 ${summary.uploaded} / 失败 ${summary.failed}`);
        break;
      }
      case 'status':
        printStatus(ctx);
        break;
      case 'serve': {
        const stop = { stopped: false };
        process.on('SIGINT', () => { stop.stopped = true; });
        process.on('SIGTERM', () => { stop.stopped = true; });
        await runForever(ctx, stop);
        break;
      }
      default:
        console.log('用法: npm run once|serve|status|retry-failed [--force] [--account 名称]');
    }
  } finally {
    ctx.store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
