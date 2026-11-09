import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DownloadConfig } from './types.js';

export class DownloadError extends Error {}

export interface DownloadResult {
  filePath: string;
  bytes: number;
  contentType: string;
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
    return { filePath: target, bytes, contentType };
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
