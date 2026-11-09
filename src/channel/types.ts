import type { RawVideo, VideoListResult } from '../types.js';

/**
 * 通道抽象：切换数据源（自建 DTK / 付费 API）时只替换实现。
 */
export interface Channel {
  readonly name: string;
  listUserVideos(secUserId: string, cursor: string): Promise<VideoListResult>;
  resolveVideo(video: RawVideo): Promise<RawVideo>;
}

export class ChannelError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ChannelError';
  }
}
