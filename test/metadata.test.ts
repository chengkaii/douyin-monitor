import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, buildObjectKey } from '../src/metadata.js';
import type { RawVideo } from '../src/types.js';

const video: RawVideo = {
  videoId: '7450000000000000001',
  secUserId: 'MS4wLjABAAAA_DEMO_USER',
  desc: '示例文案 #短剧',
  createTime: 1762400000,
  authorNickname: '示例账号A',
  authorSignature: 'mock',
  stats: { digg_count: 100 },
  playUrl: 'http://127.0.0.1/media/1.mp4',
  shareUrl: 'https://www.douyin.com/video/7450000000000000001',
};

test('OSS key 按 账号前8位/年月/视频ID 组织', () => {
  const key = buildObjectKey('douyin-monitor/', video, 'mp4');
  assert.match(key, /^douyin-monitor\/MS4wLjAB\/\d{6}\/7450000000000000001\.mp4$/);
  const jsonKey = buildObjectKey('douyin-monitor/', video, 'json');
  assert.ok(jsonKey.endsWith('.json'));
  assert.equal(jsonKey.replace('.json', ''), key.replace('.mp4', ''));
});

test('manifest 包含下游转录程序需要的全部字段', () => {
  const m = buildManifest(video, {
    discoveredAt: 1762400500,
    uploadedAt: 1762400600,
    videoFile: '7450000000000000001.mp4',
    videoUrl: 'https://oss.example.com/a.mp4',
  });
  assert.equal(m.videoId, video.videoId);
  assert.equal(m.desc, video.desc);
  assert.equal(m.createTime, video.createTime);
  assert.equal(m.author.nickname, '示例账号A');
  assert.equal(m.stats.digg_count, 100);
  assert.equal(m.videoFile, '7450000000000000001.mp4');
  assert.equal(m.videoUrlOss, 'https://oss.example.com/a.mp4');
  assert.equal(m.sourceUrl, video.shareUrl);
});
