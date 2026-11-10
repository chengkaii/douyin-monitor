import type { Manifest, RawVideo } from './types.js';

/**
 * 只在这一处把归一化后的视频转成对云端程序的交付契约。
 * DTK 字段变化、manifest 加字段，都只改这个文件。
 */
export function buildManifest(
  video: RawVideo,
  args: {
    discoveredAt: number;
    uploadedAt: number;
    videoFile: string;
    videoUrl?: string;
    /** 交付 MP4 的完整性指纹，云端消费前可据此校验文件是否完整 */
    videoSha256: string;
    videoBytes: number;
  },
): Manifest {
  return {
    videoId: video.videoId,
    secUserId: video.secUserId,
    author: {
      nickname: video.authorNickname,
      signature: video.authorSignature,
    },
    desc: video.desc,
    createTime: video.createTime,
    stats: video.stats,
    sourceUrl: video.shareUrl,
    videoFile: args.videoFile,
    videoUrlOss: args.videoUrl ?? '',
    videoSha256: args.videoSha256,
    videoBytes: args.videoBytes,
    discoveredAt: args.discoveredAt,
    uploadedAt: args.uploadedAt,
  };
}

/** OSS key：douyin-monitor/{secUserId前8位}/{yyyyMM}/{videoId}.{ext} */
export function buildObjectKey(prefix: string, video: RawVideo, ext: string, createTime = video.createTime): string {
  const safePrefix = prefix.replace(/^\/+|\/+$/g, '');
  const shortUser = (video.secUserId || 'unknown').slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, '');
  const date = createTime > 0 ? new Date(createTime * 1000) : new Date();
  const ym = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  return `${safePrefix}/${shortUser || 'unknown'}/${ym}/${video.videoId}.${ext}`;
}
