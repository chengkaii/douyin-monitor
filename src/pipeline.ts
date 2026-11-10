import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import type { Channel } from './channel/index.js';
import type { AppConfig, RawVideo } from './types.js';
import type { Store, VideoRow } from './store.js';
import type { Sink } from './sink.js';
import type { Notifier } from './notify.js';
import { dueAccounts, nextPollDelayMs, type RateLimiter } from './scheduler.js';
import { downloadVideo, reuseLocalVideo } from './downloader.js';
import { buildManifest, buildObjectKey } from './metadata.js';
import { publicUrl } from './sink.js';

export interface PipelineContext {
  config: AppConfig;
  store: Store;
  channel: Channel;
  sink: Sink;
  notifier: Notifier;
  limiter: RateLimiter;
  now: () => number;
}

export interface RunSummary {
  polled: string[];
  discovered: number;
  uploaded: number;
  failed: number;
  errors: string[];
}

const MAX_PAGES = 3;

export function rowToVideo(row: VideoRow): RawVideo {
  return {
    videoId: row.video_id,
    secUserId: row.sec_user_id,
    desc: row.desc,
    createTime: row.create_time,
    authorNickname: '',
    authorSignature: '',
    stats: {},
    playUrl: '',
    shareUrl: '',
  };
}

/** 轮询单个账号：拉取首页（必要时深翻页）→ 增量入库 → 更新轮询状态 */
export async function pollAccount(
  ctx: PipelineContext,
  secUserId: string,
  name: string,
): Promise<number> {
  const now = ctx.now();
  const state = ctx.store.getPollState(secUserId);
  let discovered = 0;
  let firstPageEmpty = false;

  try {
    let cursor = '0';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      await ctx.limiter.acquire();
      const result = await ctx.channel.listUserVideos(secUserId, cursor);
      if (page === 0 && result.videos.length === 0) firstPageEmpty = true;
      const fresh = ctx.store.insertNew(result.videos, now);
      discovered += fresh.length;
      // 单次发现接近整页，说明可能有积压，继续翻页补齐
      const needMore = result.hasMore && fresh.length >= ctx.config.dtk.postsCount - 5;
      if (!needMore || !result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }

    const delay = nextPollDelayMs(ctx.config.polling, 0, new Date(now));
    ctx.store.setPollState({
      sec_user_id: secUserId,
      last_poll_at: now,
      next_poll_at: now + delay,
      fail_streak: 0,
      last_ok_at: now,
    });
    ctx.notifier.info('poll', `${name}: 新增 ${discovered} 条`);
    // 接口返回的是合法空数组（结构没问题），但老账号历史有作品却突然全空：
    // 常见于 Cookie 失效 / 上游返回游客视角，属于"静默失败"，留一条明确信号。
    if (firstPageEmpty && (state === undefined || ctx.store.countVideos(secUserId) > 0)) {
      ctx.notifier.warn('poll-empty', `${name}: 首页返回空作品列表，请核对登录态/接口权限是否失效`);
    }
    return discovered;
  } catch (err) {
    const streak = (state?.fail_streak ?? 0) + 1;
    const delay = nextPollDelayMs(ctx.config.polling, streak, new Date(now));
    ctx.store.setPollState({
      sec_user_id: secUserId,
      last_poll_at: now,
      next_poll_at: now + delay,
      fail_streak: streak,
      last_ok_at: state?.last_ok_at ?? 0,
    });
    const message = `${name} 轮询失败（连续 ${streak} 次）: ${(err as Error).message}`;
    await ctx.notifier.error('poll', message);
    throw err;
  }
}

/** 处理单条视频：解析 → 下载/复用 → manifest → 上传（MP4 先、JSON 后）→ 状态闭环 */
export async function processVideo(ctx: PipelineContext, video: RawVideo): Promise<void> {
  const { store, config } = ctx;
  const prior = store.getVideo(video.videoId);
  store.bumpAttempt(video.videoId);
  store.setStatus(video.videoId, 'downloading');

  let localPath: string | undefined;
  let jsonPath: string | undefined;
  let localReady = false; // 本地 MP4 已校验完整，失败时保留供补传
  let delivered = false;

  try {
    const resolved = await ctx.channel.resolveVideo(video);
    if (!resolved.playUrl.startsWith('http')) {
      throw new Error(`未拿到播放地址 (videoId=${video.videoId})，检查 DTK_VIDEO_PATH 配置`);
    }

    // 补传优先复用上一轮已校验过的本地文件，避免重复下载整个视频
    const priorPath = prior?.local_path ?? '';
    const priorBytes = prior?.local_bytes ?? null;
    const priorSha = prior?.local_sha256 ?? '';
    const reused = priorPath && priorSha
      ? await reuseLocalVideo(priorPath, config.download, {
          bytes: priorBytes, sha256: priorSha,
        })
      : undefined;
    const downloaded = reused ?? await downloadVideo(
      resolved.playUrl,
      video.videoId,
      config.paths.tmp,
      config.download,
    );
    if (reused) ctx.notifier.info('pipeline', `${video.videoId} 复用已校验的本地文件，跳过下载`);
    localPath = downloaded.filePath;
    store.setStatus(video.videoId, 'downloaded', {
      local_path: downloaded.filePath,
      local_bytes: downloaded.bytes,
      local_sha256: downloaded.sha256,
      error: '',
    });
    localReady = true;

    const mp4Key = buildObjectKey(config.ossPrefix, resolved, 'mp4');
    const uploadedAt = ctx.now();
    const manifest = buildManifest(resolved, {
      discoveredAt: store.getVideo(video.videoId)?.discovered_at ?? uploadedAt,
      uploadedAt,
      videoFile: `${video.videoId}.mp4`,
      videoUrl: publicUrl(config, mp4Key),
      videoSha256: downloaded.sha256,
      videoBytes: downloaded.bytes,
    });
    jsonPath = path.join(config.paths.tmp, `${video.videoId}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(manifest, null, 2), 'utf8');

    // 顺序即契约：MP4 先落地并核对大小，JSON 作为「就绪标记」最后上传，
    // 避免云端看到 JSON 却拿到半截 MP4。put 本身按 key + 大小幂等。
    await ctx.sink.put(mp4Key, downloaded.filePath);
    if (ctx.sink.stat) {
      const remote = await ctx.sink.stat(mp4Key);
      if (!remote || remote.size !== downloaded.bytes) {
        throw new Error(
          `MP4 交付校验失败 (${mp4Key}): 远端 ${remote?.size ?? '缺失'}B / 本地 ${downloaded.bytes}B`,
        );
      }
    }
    const jsonKey = buildObjectKey(config.ossPrefix, resolved, 'json');
    await ctx.sink.put(jsonKey, jsonPath);
    if (ctx.sink.stat) {
      const remoteJson = await ctx.sink.stat(jsonKey);
      if (!remoteJson) throw new Error(`JSON Manifest 交付校验失败 (${jsonKey}): 远端未找到`);
    }

    store.setStatus(video.videoId, 'uploaded', {
      oss_key: mp4Key,
      uploaded_at: uploadedAt,
      error: '',
      local_path: null,
      local_bytes: null,
      local_sha256: null,
    });
    ctx.notifier.info('pipeline', `${video.videoId} 已交付 (${downloaded.bytes} B, sha256 ${downloaded.sha256.slice(0, 12)}…)`);
    delivered = true;
  } catch (err) {
    const message = (err as Error).message;
    const attempts = store.getVideo(video.videoId)?.attempts ?? 0;
    // 完整文件还在且未到尝试上限：保持 downloaded，下一轮直接补传（不重新下载、不进 failed 重投）
    if (localReady && localPath && fs.existsSync(localPath) && attempts < config.retry.maxAttempts) {
      store.setStatus(video.videoId, 'downloaded', { error: message });
    } else if (localReady) {
      store.setStatus(video.videoId, 'failed', { error: message });
    } else {
      store.setStatus(video.videoId, 'failed', {
        error: message, local_path: null, local_bytes: null, local_sha256: null,
      });
    }
    await ctx.notifier.error('pipeline', `${video.videoId} 处理失败: ${message}`);
    throw err;
  } finally {
    // JSON 每轮重新生成，任何分支都不残留；MP4 只在交付成功后删，失败时留着给补传复用
    if (jsonPath && fs.existsSync(jsonPath)) fs.rmSync(jsonPath, { force: true });
    if ((delivered || !localReady) && localPath && fs.existsSync(localPath)) {
      fs.rmSync(localPath, { force: true });
    }
  }
}

/** 跑一轮：轮询到期账号 → 处理待办队列 */
export async function runOnce(
  ctx: PipelineContext,
  options: {
    force?: boolean;
    accountName?: string;
    includeFailed?: boolean;
    ignoreRetryCap?: boolean;
  } = {},
): Promise<RunSummary> {
  const summary: RunSummary = { polled: [], discovered: 0, uploaded: 0, failed: 0, errors: [] };
  const enabled = ctx.config.accounts.filter(
    (a) => a.enabled && (!options.accountName || a.name === options.accountName),
  );
  const targets = options.force
    ? enabled
    : dueAccounts(enabled, (id) => ctx.store.getPollState(id), ctx.now());

  for (const account of targets) {
    try {
      summary.discovered += await pollAccount(ctx, account.secUserId, account.name);
      summary.polled.push(account.name);
    } catch (err) {
      summary.errors.push(`${account.name}: ${(err as Error).message}`);
    }
  }

  const queueRows = [
    ...ctx.store.listByStatus('pending'),
    ...ctx.store.listByStatus('downloaded'),
  ];
  if (options.includeFailed) {
    queueRows.push(...ctx.store.listRetryable(
      options.ignoreRetryCap ? Number.MAX_SAFE_INTEGER : ctx.config.retry.maxAttempts,
    ));
  }
  const queue = queueRows.map(rowToVideo);

  const limit = pLimit(Math.max(1, ctx.config.download.concurrency));
  const results = await Promise.allSettled(
    queue.map((video) => limit(() => processVideo(ctx, video))),
  );
  for (const r of results) {
    if (r.status === 'fulfilled') summary.uploaded += 1;
    else {
      summary.failed += 1;
      summary.errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  }
  return summary;
}

/** 常驻模式：每 15s 检查是否有到期账号；每 N 轮顺带扫一次 failed（带尝试上限） */
export async function runForever(
  ctx: PipelineContext,
  stopSignal?: { stopped: boolean },
  options: { tickMs?: number } = {},
): Promise<void> {
  const tickMs = options.tickMs ?? 15_000;
  const everyRounds = Math.max(1, ctx.config.retry.everyRounds);
  let round = 0;
  ctx.notifier.info('serve', `常驻启动，${ctx.config.accounts.length} 个账号，通道 ${ctx.channel.name}，sink ${ctx.sink.name}，失败重投每 ${everyRounds} 轮 / 上限 ${ctx.config.retry.maxAttempts} 次`);
  while (!stopSignal?.stopped) {
    try {
      const summary = await runOnce(ctx, { includeFailed: round % everyRounds === 0 });
      if (summary.discovered > 0 || summary.uploaded > 0 || summary.errors.length > 0) {
        ctx.notifier.info('serve', `本轮: 发现 ${summary.discovered} / 交付 ${summary.uploaded} / 失败 ${summary.failed}`);
      }
    } catch (err) {
      await ctx.notifier.error('serve', `主循环异常: ${(err as Error).message}`);
    }
    round += 1;
    await new Promise((r) => setTimeout(r, tickMs));
  }
}
