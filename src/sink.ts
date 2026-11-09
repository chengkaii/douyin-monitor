import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './types.js';

export interface Sink {
  readonly name: string;
  put(key: string, filePath: string): Promise<{ url: string }>;
}

/** 本地 outbox：零凭据演练用，目录结构与 OSS key 完全一致 */
export class LocalSink implements Sink {
  readonly name = 'local';

  constructor(private readonly outboxDir: string) {}

  async put(key: string, filePath: string): Promise<{ url: string }> {
    const target = path.join(this.outboxDir, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(filePath, target);
    return { url: `file://${target}` };
  }
}

export class OssSink implements Sink {
  readonly name = 'oss';

  constructor(private readonly cfg: AppConfig['oss']) {}

  async put(key: string, filePath: string): Promise<{ url: string }> {
    const { default: OSS } = await import('ali-oss');
    const client = new OSS({
      region: this.cfg.region,
      bucket: this.cfg.bucket,
      accessKeyId: this.cfg.accessKeyId,
      accessKeySecret: this.cfg.accessKeySecret,
    });
    const result = await client.put(key, filePath);
    return {
      url: result.url || `https://${this.cfg.bucket}.${this.cfg.region}.aliyuncs.com/${key}`,
    };
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
