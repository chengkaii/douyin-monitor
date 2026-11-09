import test from 'node:test';
import assert from 'node:assert/strict';
import { findVideoArray, findVideoArrayWithMeta, findPlayUrl, findStats, findAuthor, findCursor } from '../src/normalize.js';

test('作品数组能从多种包装形状中找出', () => {
  assert.equal(findVideoArray({ data: { aweme_list: [{ aweme_id: '1' }] } }).length, 1);
  assert.equal(findVideoArray({ result: { posts: [{ aweme_id: '1' }, { aweme_id: '2' }] } }).length, 2);
  assert.equal(findVideoArray({ data: { list: [{ id: '1' }] } }).length, 1);
  assert.equal(findVideoArray({ code: 0, data: [] }).length, 0);
});

test('区分「合法空列表」与「响应结构不符」', () => {
  assert.deepEqual(
    findVideoArrayWithMeta({ data: { posts: [], cursor: 0, has_more: false } }),
    { rows: [], found: true },
  );
  assert.deepEqual(
    findVideoArrayWithMeta({ code: -1, message: '登录态失效', data: null }),
    { rows: [], found: false },
  );
  assert.deepEqual(findVideoArrayWithMeta({ success: false, error: 'forbidden' }), { rows: [], found: false });
  assert.equal(findVideoArrayWithMeta({ data: { posts: [{ aweme_id: '1' }] } }).rows.length, 1);
});

test('播放地址兼容 v4 嵌套结构与扁平字段', () => {
  assert.equal(
    findPlayUrl({ video: { play_addr: { url_list: ['https://cdn/a.mp4', 'https://cdn/b.mp4'] } } }),
    'https://cdn/a.mp4',
  );
  assert.equal(findPlayUrl({ playUrl: 'https://cdn/c.mp4' }), 'https://cdn/c.mp4');
  assert.equal(findPlayUrl({ video: { bit_rate: [{ play_addr: { url_list: ['https://cdn/d.mp4'] } }] } }), 'https://cdn/d.mp4');
});

test('统计与作者信息归一化', () => {
  assert.deepEqual(
    findStats({ statistics: { digg_count: 12, comment_count: 3, extra: 'x' } }),
    { digg_count: 12, comment_count: 3 },
  );
  assert.deepEqual(
    findAuthor({ author: { nickname: '账号A', signature: '简介' } }),
    { nickname: '账号A', signature: '简介' },
  );
});

test('游标解析：首页 0 与 has_more', () => {
  assert.deepEqual(findCursor({ data: { cursor: 0, has_more: false } }), { cursor: '0', hasMore: false });
  assert.deepEqual(findCursor({ data: { max_cursor: 1762400000000, has_more: true } }), {
    cursor: '1762400000000', hasMore: true,
  });
});
