/**
 * 抖音 sec_user_id 解析：纯本地正则 + 短链 HEAD 重定向，零 DTK scope、零浏览器。
 *
 * 借鉴 eric1981/douyin-monitor 的 utils.resolve_secuid，但做了两处收紧：
 *   1. 短链只跟随 douyin.com 域内的重定向（防 SSRF），手动跟最多 N 跳；
 *   2. 所有网络行为可注入 fetch / timeout，便于脱网单测。
 *
 * 支持四种输入：纯 sec_user_id、/user/ 主页链接、v.douyin.com 短链、
 * 「长按复制此条消息… https://v.douyin.com/xxx/」这类分享文案。
 */

const SEC_UID_RE = /^MS4w[A-Za-z0-9_-]{16,}$/;
const USER_PATH_RE = /\/user\/([A-Za-z0-9_-]{16,})/;
const URL_RE = /https?:\/\/(?:www\.|v\.)?douyin\.com\/[^\s"'，。、）)】]+/i;
const DOUYIN_HOST_RE = /(?:^|\.)douyin\.com$/i;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export type SecUidSource = 'sec_uid' | 'user_url' | 'share_text' | 'short_link' | 'unknown';

export interface SecUidResult {
  secUid?: string;
  error?: string;
  source: SecUidSource;
}

export interface ResolveOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
}

/** 同步解析：只认「纯 sec_user_id」和「能从文本里抠出的 /user/ 主页链接」 */
export function extractSecUid(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (SEC_UID_RE.test(text)) return text;
  const url = text.startsWith('http') ? text : URL_RE.exec(text)?.[0] ?? '';
  if (!url) return null;
  return USER_PATH_RE.exec(url)?.[1] ?? null;
}

/** 判断一个值是否为合法的 sec_user_id（供配置校验复用） */
export function isSecUid(value: string): boolean {
  return SEC_UID_RE.test(value.trim());
}

/**
 * 完整解析。同步能命中就直接返回（不碰网络）；只有短链才发 HEAD 请求。
 * 短链解析失败时给出可操作的降级提示，而不是抛异常。
 */
export async function resolveSecUid(raw: string, options: ResolveOptions = {}): Promise<SecUidResult> {
  const text = raw.trim();
  const local = extractSecUid(text);
  if (local) {
    const source: SecUidSource = text === local
      ? 'sec_uid'
      : (text.startsWith('http') ? 'user_url' : 'share_text');
    return { secUid: local, source };
  }

  const urlText = text.startsWith('http') ? text : URL_RE.exec(text)?.[0] ?? '';
  if (!urlText) {
    return {
      source: 'unknown',
      error: '未找到抖音链接或 sec_user_id；请粘贴主页链接、分享文案或纯 sec_user_id',
    };
  }

  let candidate: URL;
  try {
    candidate = new URL(urlText);
  } catch {
    return { source: 'unknown', error: '链接格式不合法' };
  }
  if (!DOUYIN_HOST_RE.test(candidate.hostname)) {
    return { source: 'unknown', error: `只允许解析 douyin.com 链接（收到 ${candidate.hostname}）` };
  }

  const doFetch = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? 8_000;
  const maxRedirects = options.maxRedirects ?? 4;

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const res = await doFetch(candidate.toString(), {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': UA },
      });

      if (REDIRECT_CODES.has(res.status)) {
        const location = res.headers.get('location');
        if (!location) {
          return { source: 'short_link', error: `短链返回 ${res.status} 但没有 Location 头` };
        }
        const next = new URL(location, candidate);
        if (!DOUYIN_HOST_RE.test(next.hostname)) {
          return { source: 'short_link', error: `短链重定向到非抖音域名 ${next.hostname}，已拒绝跟随` };
        }
        candidate = next;
        const hit = extractSecUid(next.toString());
        if (hit) return { secUid: hit, source: 'short_link' };
        continue;
      }

      // 部分 CDN 对 HEAD 回 405，但 Location 已经拿到；不当成错误
      if (!res.ok && res.status !== 405) {
        return { source: 'short_link', error: `短链探测返回 HTTP ${res.status}` };
      }
      break;
    }
  } catch (err) {
    return {
      source: 'short_link',
      error: `短链解析失败: ${(err as Error).message}；请改粘浏览器重定向后的 /user/ 主页链接`,
    };
  }

  const hit = extractSecUid(candidate.toString());
  if (hit) return { secUid: hit, source: 'short_link' };
  return {
    source: 'short_link',
    error: '短链已解析但没拿到 /user/ 主页地址；请改粘浏览器重定向后的主页链接',
  };
}
