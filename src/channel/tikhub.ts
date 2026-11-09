import { ChannelError, type Channel } from './types.js';
import type { RawVideo, VideoListResult } from '../types.js';

/**
 * 备用通道占位：被风控时可切 TikHub 等付费聚合 API。
 * 只需实现本文件的两个方法，其余链路（去重/下载/OSS）完全不用改。
 */
export class TikHubChannel implements Channel {
  readonly name = 'tikhub';

  async listUserVideos(_secUserId: string, _cursor: string): Promise<VideoListResult> {
    throw new ChannelError('TikHub 通道尚未启用：请在 .env 中设置凭据并补齐 src/channel/tikhub.ts');
  }

  async resolveVideo(video: RawVideo): Promise<RawVideo> {
    throw new ChannelError('TikHub 通道尚未启用');
  }
}
