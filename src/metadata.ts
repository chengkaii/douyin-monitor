import { createHash } from 'node:crypto';
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

/**
 * OSS key：douyin-monitor/{secUserId 的 sha256 前 12 位}/{yyyyMM}/{videoId}.{ext}
 *
 * 不能截 secUserId 前 8 位当目录：抖音 sec_user_id 普遍以 MS4wLjABAAAA 开头，
 * 20+ 个账号会全部落进同一个 MS4wLjAB/ 目录，按账号归档和排查直接失效。
 * 哈希保证「同一账号稳定映射、不同账号不撞车」，且与账号改名无关。
 */
export function buildObjectKey(prefix: string, video: RawVideo, ext: string, createTime = video.createTime): string {
  const safePrefix = prefix.replace(/^\/+|\/+$/g, '');
  const accountDir = createHash('sha256')
    .update(video.secUserId || 'unknown')
    .digest('hex')
    .slice(0, 12);
  const date = createTime > 0 ? new Date(createTime * 1000) : new Date();
  const ym = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  return `${safePrefix}/${accountDir}/${ym}/${video.videoId}.${ext}`;
}
