import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './types.js';

export interface Sink {
  readonly name: string;
  put(key: string, filePath: string): Promise<{ url: string }>;
  /** 远端对象大小；不存在返回 undefined。用于 MP4/JSON 配对校验与上传幂等 */
  stat?(key: string): Promise<{ size: number } | undefined>;
}

/** 本地 outbox：零凭据演练用，目录结构与 OSS key 完全一致 */
export class LocalSink implements Sink {
  readonly name = 'local';

  constructor(private readonly outboxDir: string) {}

  private target(key: string): string {
    return path.join(this.outboxDir, key);
  }

  async stat(key: string): Promise<{ size: number } | undefined> {
    try {
      return { size: fs.statSync(this.target(key)).size };
    } catch {
      return undefined;
    }
  }

  async put(key: string, filePath: string): Promise<{ url: string }> {
    const target = this.target(key);
    const url = `file://${target}`;
    // 幂等：同 key 且远端大小与本地一致，视为已上传，不重复写盘
    if ((await this.stat(key))?.size === fs.statSync(filePath).size) return { url };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(filePath, target);
    return { url };
  }
}

export class OssSink implements Sink {
  readonly name = 'oss';

  constructor(private readonly cfg: AppConfig['oss']) {}

  private url(key: string): string {
    return `https://${this.cfg.bucket}.${this.cfg.region}.aliyuncs.com/${key}`;
  }

  private options(): { region: string; bucket: string; accessKeyId: string; accessKeySecret: string } {
    return {
      region: this.cfg.region,
      bucket: this.cfg.bucket,
      accessKeyId: this.cfg.accessKeyId,
      accessKeySecret: this.cfg.accessKeySecret,
    };
  }

  async stat(key: string): Promise<{ size: number } | undefined> {
    const { default: OSS } = await import('ali-oss');
    const client = new OSS(this.options());
    try {
      const head = await client.head(key);
      const size = Number(head.meta['content-length'] ?? head.meta['Content-Length'] ?? 0);
      return Number.isFinite(size) && size > 0 ? { size } : undefined;
    } catch {
      return undefined;
    }
  }

  async put(key: string, filePath: string): Promise<{ url: string }> {
    const { default: OSS } = await import('ali-oss');
    const client = new OSS(this.options());
    const size = fs.statSync(filePath).size;
    // 幂等：远端已存在且大小一致（key 由 videoId 唯一决定），跳过覆盖上传
    try {
      const head = await client.head(key);
      if (Number(head.meta['content-length'] ?? 0) === size) return { url: this.url(key) };
    } catch {
      // 对象不存在（NoSuchKey），走正常上传
    }
    const result = await client.put(key, filePath);
    return { url: result.url || this.url(key) };
  }
}

export function createSink(config: AppConfig): Sink {
  return config.sink === 'oss'
    ? new OssSink(config.oss)
    : new LocalSink(config.paths.outbox);
}

/** 公开访问 URL（写进 manifest，供云端程序直接取流） */
export function publicUrl(config: AppConfig, key: string): string {
  if (config.sink === 'local') return `file://${path.join(config.paths.outbox, key)}`;
  return `https://${config.oss.bucket}.${config.oss.region}.aliyuncs.com/${key}`;
}
