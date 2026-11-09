/**
 * DTK v5 的响应结构不写死在 README（由实例 /openapi.json 生成）。
 * 这一层做防御式归一化：只要响应里能找到常见形状的数组/字段就解析出来，
 * 避免接口字段微调就导致整条链路断裂。
 */

export type Json = unknown;

export function asRecord(v: Json): Record<string, Json> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, Json>)
    : {};
}

export function pickString(obj: Record<string, Json>, keys: string[]): string {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

export function pickNumber(obj: Record<string, Json>, keys: string[]): number {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return 0;
}

/** 沿常见包装层（data/result/response）向下找目标对象 */
export function unwrap(v: Json, depth = 4): Record<string, Json> {
  let cur = v;
  for (let i = 0; i < depth; i += 1) {
    const rec = asRecord(cur);
    const next = rec['data'] ?? rec['result'] ?? rec['response'];
    if (next === undefined || next === cur) return rec;
    cur = next;
  }
  return asRecord(cur);
}

const LIST_KEYS = ['aweme_list', 'posts', 'items', 'list', 'videos', 'data', 'results'];

/**
 * 与 findVideoArray 同义，但额外返回「是否真的找到了数组容器」。
 * 空数组 = 账号确实没作品；找不到容器 = 错误体 / 字段改名，必须报错而不是当成 0 新增。
 */
export function findVideoArrayWithMeta(v: Json, depth = 5): { rows: Json[]; found: boolean } {
  if (Array.isArray(v)) return { rows: v, found: true };
  const rec = asRecord(v);
  let empty: Json[] | undefined;
  for (const key of LIST_KEYS) {
    const candidate = rec[key];
    if (Array.isArray(candidate) && candidate.length > 0) return { rows: candidate, found: true };
    if (Array.isArray(candidate) && empty === undefined) empty = candidate;
  }
  if (depth > 0) {
    for (const key of ['data', 'result', 'response', 'aweme_list', 'posts']) {
      const nested = rec[key];
      if (nested !== undefined && nested !== null) {
        const sub = findVideoArrayWithMeta(nested, depth - 1);
        if (sub.found && sub.rows.length > 0) return sub;
        if (sub.found && empty === undefined) empty = sub.rows;
      }
    }
  }
  return empty !== undefined ? { rows: empty, found: true } : { rows: [], found: false };
}

/** 从任意嵌套层里找出"作品数组" */
export function findVideoArray(v: Json, depth = 5): Json[] {
  return findVideoArrayWithMeta(v, depth).rows;
}

/** 从作品对象里提取可播放地址（优先级：无水印 > play > bitrate 列表） */
export function findPlayUrl(raw: Json): string {
  const rec = asRecord(raw);
  const direct = pickString(rec, [
    'playUrl', 'play_url', 'playAddr', 'play_addr', 'downloadUrl', 'download_url',
    'url', 'videoUrl', 'video_url', 'mediaUrl', 'media_url',
  ]);
  if (direct.startsWith('http')) return direct;

  const video = asRecord(rec['video']);
  const playAddr = asRecord(video['play_addr']);
  const urlList = playAddr['url_list'];
  if (Array.isArray(urlList)) {
    const first = urlList.find((u): u is string => typeof u === 'string' && u.startsWith('http'));
    if (first) return first;
  }
  const nested = pickString(video, ['play_addr', 'playAddr', 'download_addr', 'downloadAddr']);
  if (nested.startsWith('http')) return nested;

  const bitrate = video['bit_rate'] ?? video['bitrate'];
  if (Array.isArray(bitrate) && bitrate.length > 0) {
    const first = asRecord(bitrate[0]);
    const addr = asRecord(first['play_addr']);
    const list = addr['url_list'];
    if (Array.isArray(list)) {
      const u = list.find((x): x is string => typeof x === 'string' && x.startsWith('http'));
      if (u) return u;
    }
  }
  return direct.startsWith('http') ? direct : '';
}

/** 从作品对象里提取统计数字 */
export function findStats(raw: Json): Record<string, number> {
  const rec = asRecord(raw);
  const stats = asRecord(rec['statistics'] ?? rec['stats'] ?? rec['counter']);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  if (Object.keys(out).length === 0) {
    for (const k of ['digg_count', 'comment_count', 'share_count', 'collect_count', 'play_count']) {
      if (typeof rec[k] === 'number') out[k] = rec[k] as number;
    }
  }
  return out;
}

export function findAuthor(raw: Json): { nickname: string; signature: string } {
  const rec = asRecord(raw);
  const author = asRecord(rec['author'] ?? rec['user'] ?? rec['authorInfo']);
  return {
    nickname: pickString(author, ['nickname', 'name', 'nick_name']),
    signature: pickString(author, ['signature', 'desc', 'bio']),
  };
}

export function findCursor(v: Json): { cursor: string; hasMore: boolean } {
  const rec = unwrap(v);
  const cursorValue = rec['cursor'] ?? rec['max_cursor'] ?? rec['nextCursor'] ?? rec['next_cursor'];
  const cursor = typeof cursorValue === 'number' || typeof cursorValue === 'string'
    ? String(cursorValue)
    : '0';
  const hasMoreRaw = rec['has_more'] ?? rec['hasMore'] ?? rec['has_next'];
  const hasMore = hasMoreRaw === true || hasMoreRaw === 1 || (cursor !== '0' && cursor !== '');
  return { cursor, hasMore };
}
