/**
 * accounts.yaml 的文本级账号录入。
 *
 * 不走 YAML parse → stringify：那会丢掉注释、缩进和键顺序。这里按行编辑，
 * 只替换 accounts: 段里的列表项，其余原样保留。
 */

export interface UpsertResult {
  text: string;
  added: boolean;
  reason?: string;
  /** 写入前已有的账号数（用于自动生成「账号N」） */
  existingCount: number;
}

const ACCOUNTS_HEADER_RE = /^accounts\s*:\s*(?:\[\s*\])?\s*(?:#.*)?$/;
const TOP_LEVEL_KEY_RE = /^[A-Za-z_][\w-]*\s*:/;
const LIST_ITEM_RE = /^\s+-\s/;
const SEC_LINE_RE = /^\s*sec_user_id\s*:\s*["']?([^"'\s#]+)/;
const PLACEHOLDER_RE = /replace_me/i;

function escapeQuoted(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"').trim();
}

/** 把 accounts: 段切成若干列表项块，段首注释/空行单独保留 */
function splitSegment(segment: string[]): { leading: string[]; blocks: string[][] } {
  const leading: string[] = [];
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of segment) {
    if (LIST_ITEM_RE.test(line)) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      leading.push(line);
    }
  }
  if (current) blocks.push(current);
  return { leading, blocks };
}

function secUidOf(block: string[]): string {
  for (const line of block) {
    const hit = SEC_LINE_RE.exec(line);
    if (hit?.[1]) return hit[1];
  }
  return '';
}

/** 已有账号条数（含禁用的），用于自动命名 */
export function countAccounts(text: string): number {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => ACCOUNTS_HEADER_RE.test(l ?? ''));
  if (start < 0) return 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (TOP_LEVEL_KEY_RE.test(lines[i] ?? '')) { end = i; break; }
  }
  return splitSegment(lines.slice(start + 1, end)).blocks.length;
}

/**
 * 写入一个账号。已存在同 sec_user_id 则原样返回（added=false）；
 * 模板里的 REPLACE_ME 占位条目会被自动清掉。
 */
export function upsertAccountText(original: string, secUid: string, name: string): UpsertResult {
  const lines = original.split(/\r?\n/);
  const start = lines.findIndex((l) => ACCOUNTS_HEADER_RE.test(l ?? ''));

  if (start < 0) {
    const base = original.trimEnd();
    const text = `${base}${base ? '\n\n' : ''}accounts:\n  - name: "${escapeQuoted(name)}"\n    sec_user_id: "${secUid}"\n    enabled: true\n`;
    return { text, added: true, existingCount: 0 };
  }

  // accounts: [] 这种空列表写法改成可追加的块列表
  lines[start] = 'accounts:';

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (TOP_LEVEL_KEY_RE.test(lines[i] ?? '')) { end = i; break; }
  }

  const { leading, blocks } = splitSegment(lines.slice(start + 1, end));
  const existingCount = blocks.length;
  if (blocks.some((b) => secUidOf(b) === secUid)) {
    return { text: original, added: false, reason: '该 sec_user_id 已在账号清单中', existingCount };
  }

  const kept = blocks.filter((b) => !PLACEHOLDER_RE.test(b.join('\n')));
  const newBlock = [
    `  - name: "${escapeQuoted(name)}"`,
    `    sec_user_id: "${secUid}"`,
    '    enabled: true',
  ];

  const tail = lines.slice(end);
  // 后面还有 polling/download 等顶级段时留一行空行，避免新账号和下一个键贴在一起
  const separator = tail.length > 0 && tail[0] !== '' ? [''] : [];
  const text = [
    ...lines.slice(0, start + 1),
    ...leading,
    ...kept.flat(),
    ...newBlock,
    ...separator,
    ...tail,
  ].join('\n');
  return { text, added: true, existingCount };
}
