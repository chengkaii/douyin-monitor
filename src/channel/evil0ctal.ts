import type { AppConfig, RawVideo, VideoListResult } from '../types.js';
import {
  asRecord, findAuthor, findCursor, findPlayUrl, findStats, findVideoArray,
  findVideoArrayWithMeta, pickNumber, pickString, unwrap,
  type Json,
} from '../normalize.js';
import { ChannelError, type Channel } from './types.js';

type DtkConfig = AppConfig['dtk'];

const VIDEO_ID_KEYS = ['aweme_id', 'video_id', 'videoId', 'id', 'awemeId', 'post_id'];
const DESC_KEYS = ['desc', 'description', 'title', 'caption', 'text'];
const TIME_KEYS = ['create_time', 'createTime', 'create_at', 'publish_time', 'timestamp'];

/**
 * Evil0ctal Douyin_TikTok_Download_API v5 通道。
 *
 * v5 的 REST 路径/参数名由实例 /openapi.json 生成，因此全部走配置：
 *   npm run inspect-openapi → 找候选路径 → 写进 .env 的 DTK_POSTS_PATH 等。
 * 响应结构做防御式归一化，接口字段微调不至于打断链路。
 */
export class Evil0ctalChannel implements Channel {
  readonly name = 'evil0ctal-v5';

  constructor(private readonly cfg: DtkConfig) {}

  async listUserVideos(secUserId: string, cursor: string): Promise<VideoListResult> {
    const path = this.fillPath(this.cfg.postsPath, { userId: secUserId, cursor });
    const params: Record<string, string> = {
      [this.cfg.postsUserParam]: secUserId,
      [this.cfg.postsCountParam]: String(this.cfg.postsCount),
    };
    // DTK v5 的 cursor 是 opaque 值：第一页必须「省略该参数」，传 0 会被当成真实游标。
    if (cursor !== '' && cursor !== '0') params[this.cfg.postsCursorParam] = cursor;
    const raw = await this.request(path, params);
    const { rows, found } = findVideoArrayWithMeta(raw);
    if (!found) {
      const rec = asRecord(raw);
      const hint = pickString(rec, ['error', 'message', 'msg', 'detail'])
        || pickString(asRecord(unwrap(raw)), ['error', 'message', 'msg', 'detail']);
      throw new ChannelError(
        `DTK 作品列表响应结构不符（找不到作品数组${hint ? `，提示：${hint}` : ''}）: ${JSON.stringify(raw).slice(0, 200)}`,
      );
    }
    const videos = rows
      .map((row) => this.normalizeVideo(row, secUserId))
      .filter((v) => v.videoId.length > 0);
    // 宁可报错退避，也不能把「字段改名 / ID 解析不了」当成账号没发新作品
    if (videos.length !== rows.length) {
      throw new ChannelError(
        `DTK 作品列表 ${rows.length} 条中有 ${rows.length - videos.length} 条解析不出 video_id（字段可能已变更），拒绝按「无新增」处理`,
      );
    }
    const page = findCursor(raw);
    return { videos, nextCursor: page.cursor, hasMore: page.hasMore };
  }

  async resolveVideo(video: RawVideo): Promise<RawVideo> {
    if (video.playUrl.startsWith('http')) return video;

    const path = this.fillPath(this.cfg.videoPath, { videoId: video.videoId });
    const raw = await this.request(path, { [this.cfg.videoIdParam]: video.videoId });
    const detail = this.extractDetail(raw) ?? {};
    const rec = asRecord(detail);
    return {
      ...video,
      playUrl: findPlayUrl(detail) || video.playUrl,
      desc: pickString(rec, DESC_KEYS) || video.desc,
      createTime: pickNumber(rec, TIME_KEYS) || video.createTime,
      stats: Object.keys(findStats(detail)).length > 0 ? findStats(detail) : video.stats,
      ...(() => {
        const a = findAuthor(detail);
        return a.nickname ? { authorNickname: a.nickname, authorSignature: a.signature } : {};
      })(),
    };
  }

  private extractDetail(raw: Json): Json | undefined {
    const rec = unwrap(raw);
    for (const key of ['aweme_detail', 'video', 'post', 'detail', 'item']) {
      const v = rec[key];
      if (v !== undefined && !Array.isArray(v)) return v;
      if (Array.isArray(v) && v.length > 0) return v[0];
    }
    const arr = findVideoArray(raw);
    if (arr.length > 0) return arr[0];
    return Object.keys(rec).length > 0 ? rec : undefined;
  }

  private normalizeVideo(row: Json, secUserId: string): RawVideo {
    const rec = asRecord(row);
    const author = findAuthor(row);
    return {
      videoId: pickString(rec, VIDEO_ID_KEYS),
      desc: pickString(rec, DESC_KEYS),
      createTime: pickNumber(rec, TIME_KEYS),
      authorNickname: author.nickname,
      authorSignature: author.signature,
      stats: findStats(row),
      playUrl: findPlayUrl(row),
      shareUrl: pickString(rec, ['share_url', 'shareUrl', 'url']),
      secUserId,
    };
  }

  private fillPath(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
      const value = vars[key];
      return value === undefined ? match : encodeURIComponent(value);
    });
  }

  /** 提交请求；v5 默认返回 202 + task_id，统一在这里收敛成最终结果 */
  private async request(pathname: string, params: Record<string, string>): Promise<Json> {
    const url = new URL(pathname.startsWith('http') ? pathname : `${this.cfg.baseUrl}${pathname}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== '') url.searchParams.set(k, v);
    }
    if (this.cfg.syncWait > 0) url.searchParams.set('wait', String(this.cfg.syncWait));

    const headers: Record<string, string> = { Accept: 'application/json' };
    // DTK v5 主鉴权头是 X-API-Key（Authorization: Bearer 仅作兼容），两个都发以适配不同版本
    if (this.cfg.apiKey) {
      headers['X-API-Key'] = this.cfg.apiKey;
      headers['Authorization'] = `Bearer ${this.cfg.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      throw new ChannelError(`DTK 请求失败 ${url.pathname}: ${(err as Error).message}`, err);
    }

    const text = await response.text();
    const body = this.parseJson(text);

    if (!response.ok) {
      throw new ChannelError(`DTK ${response.status} ${url.pathname}: ${text.slice(0, 300)}`);
    }

    if (response.status === 202) {
      const rec = unwrap(body);
      const taskId = pickString(asRecord(body), ['task_id', 'taskId', 'id'])
        || pickString(rec, ['task_id', 'taskId', 'id']);
      if (!taskId) throw new ChannelError('DTK 返回 202 但没有 task_id，请检查 DTK_TASK_PATH 配置');
      return this.pollTask(taskId);
    }

    return body;
  }

  private async pollTask(taskId: string): Promise<Json> {
    const url = new URL(`${this.cfg.baseUrl}${this.fillPath(this.cfg.taskPath, { taskId })}`);
    const headers: Record<string, string> = { Accept: 'application/json' };
    // DTK v5 主鉴权头是 X-API-Key（Authorization: Bearer 仅作兼容），两个都发以适配不同版本
    if (this.cfg.apiKey) {
      headers['X-API-Key'] = this.cfg.apiKey;
      headers['Authorization'] = `Bearer ${this.cfg.apiKey}`;
    }
    const deadline = Date.now() + this.cfg.timeoutMs;

    while (Date.now() < deadline) {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
      const body = this.parseJson(await res.text());
      // status/task_id 在响应顶层，unwrap 会把 result 当成包装层往下钻，故先看顶层
      const top = asRecord(body);
      const rec = unwrap(body);
      const status = (pickString(top, ['status', 'state']) || pickString(rec, ['status', 'state'])).toLowerCase();
      if (['succeeded', 'success', 'done', 'finished', 'completed'].includes(status)) {
        return top['result'] ?? top['data'] ?? rec['result'] ?? rec['data'] ?? body;
      }
      if (['failed', 'error', 'cancelled'].includes(status)) {
        throw new ChannelError(`DTK 任务 ${taskId} 失败: ${pickString(top, ['error', 'message'])}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new ChannelError(`DTK 任务 ${taskId} 超时（${this.cfg.timeoutMs}ms）`);
  }

  private parseJson(text: string): Json {
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as Json;
    } catch {
      throw new ChannelError(`DTK 返回非 JSON: ${text.slice(0, 200)}`);
    }
  }
}
