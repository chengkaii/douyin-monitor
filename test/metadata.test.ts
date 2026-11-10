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

test('OSS key 按 账号哈希12位/年月/视频ID 组织，mp4 与 json 同目录', () => {
  const key = buildObjectKey('douyin-monitor/', video, 'mp4');
  assert.match(key, /^douyin-monitor\/[0-9a-f]{12}\/\d{6}\/7450000000000000001\.mp4$/);
  const jsonKey = buildObjectKey('douyin-monitor/', video, 'json');
  assert.ok(jsonKey.endsWith('.json'));
  assert.equal(jsonKey.replace('.json', ''), key.replace('.mp4', ''));
});

test('sec_user_id 前 8 位相同的两个账号不再撞进同一目录（review #6）', () => {
  // 抖音 sec_user_id 普遍以 MS4wLjABAAAA 开头，截前 8 位会让 20+ 账号全挤到 MS4wLjAB/
  const a = { ...video, secUserId: 'MS4wLjABAAAA_ACCOUNT_A' };
  const b = { ...video, secUserId: 'MS4wLjABAAAA_ACCOUNT_B' };
  const ka = buildObjectKey('douyin-monitor/', a, 'mp4', 1762400000);
  const kb = buildObjectKey('douyin-monitor/', b, 'mp4', 1762400000);
  assert.equal(a.secUserId.slice(0, 8), b.secUserId.slice(0, 8), '前提：两个账号前缀确实相同');
  assert.notEqual(ka.split('/')[1], kb.split('/')[1], '账号目录必须唯一');
  assert.equal(ka, buildObjectKey('douyin-monitor/', a, 'mp4', 1762400000), '同一账号映射必须稳定');
  assert.match(ka.split('/')[1] ?? '', /^[0-9a-f]{12}$/);
});

test('manifest 包含下游转录程序需要的全部字段', () => {
  const m = buildManifest(video, {
    discoveredAt: 1762400500,
    uploadedAt: 1762400600,
    videoFile: '7450000000000000001.mp4',
    videoUrl: 'https://oss.example.com/a.mp4',
    videoSha256: 'a'.repeat(64),
    videoBytes: 1024 * 1024 + 512,
  });
  assert.equal(m.videoId, video.videoId);
  assert.equal(m.desc, video.desc);
  assert.equal(m.createTime, video.createTime);
  assert.equal(m.author.nickname, '示例账号A');
  assert.equal(m.stats.digg_count, 100);
  assert.equal(m.videoFile, '7450000000000000001.mp4');
  assert.equal(m.videoUrlOss, 'https://oss.example.com/a.mp4');
  assert.equal(m.sourceUrl, video.shareUrl);
  assert.equal(m.videoSha256, 'a'.repeat(64), 'manifest 必须带 MP4 完整性指纹');
  assert.equal(m.videoBytes, 1024 * 1024 + 512, 'manifest 必须带 MP4 字节数');
});
