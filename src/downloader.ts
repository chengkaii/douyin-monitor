import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DownloadConfig } from './types.js';

export class DownloadError extends Error {}

export interface DownloadResult {
  filePath: string;
  bytes: number;
  contentType: string;
  sha256: string;
}

/** 流式算 sha256，避免把整个 MP4 读进内存 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface LocalFileExpectation {
  bytes: number | null;
  sha256: string | null;
}

/**
 * 补传时复用本地文件：必须存在、达到最小体积、且与库中记录的字节数/哈希完全一致。
 * 没有哈希基准（老库遗留行）一律不复用，回退重新下载，避免把来路不明的文件当成交付物。
 */
export async function reuseLocalVideo(
  filePath: string,
  cfg: DownloadConfig,
  expected: LocalFileExpectation,
): Promise<DownloadResult | undefined> {
  if (!filePath || !expected.sha256 || !fs.existsSync(filePath)) return undefined;
  const bytes = fs.statSync(filePath).size;
  if (bytes < cfg.minBytes) return undefined;
  if (expected.bytes !== null && expected.bytes !== bytes) return undefined;
  const sha256 = await sha256File(filePath);
  if (sha256 !== expected.sha256) return undefined;
  return { filePath, bytes, contentType: 'video/mp4', sha256 };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function downloadVideo(
  url: string,
  videoId: string,
  tmpDir: string,
  cfg: DownloadConfig,
  options: { attempt?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<DownloadResult> {
  const attempt = options.attempt ?? 0;
  const wait = options.sleepFn ?? sleep;
  fs.mkdirSync(tmpDir, { recursive: true });
  const target = path.join(tmpDir, `${videoId}.mp4`);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new DownloadError(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/video\/|application\/octet-stream|binary/i.test(contentType)) {
      throw new DownloadError(`Content-Type 异常: ${contentType}`);
    }
    if (!response.body) throw new DownloadError('响应无 body');

    await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(target));
    const bytes = fs.statSync(target).size;
    if (bytes < cfg.minBytes) {
      throw new DownloadError(`文件过小 ${bytes}B < ${cfg.minBytes}B，判定为损坏`);
    }
    return { filePath: target, bytes, contentType, sha256: await sha256File(target) };
  } catch (err) {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    if (attempt < cfg.maxRetries - 1) {
      const delay = cfg.retryDelaysMs[Math.min(attempt, cfg.retryDelaysMs.length - 1)] ?? 30_000;
      await wait(delay);
      return downloadVideo(url, videoId, tmpDir, cfg, { ...options, attempt: attempt + 1 });
    }
    throw new DownloadError(
      `下载失败（重试 ${cfg.maxRetries} 次）: ${(err as Error).message}`,
    );
  }
}
