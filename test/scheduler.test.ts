import test from 'node:test';
import assert from 'node:assert/strict';
import { isNight, backoffMs, nextPollDelayMs, dueAccounts, isDue, hourInTimeZone } from '../src/scheduler.js';
import type { PollingConfig } from '../src/types.js';

const polling: PollingConfig = {
  intervalMinutes: 5,
  jitterSeconds: 0,
  minGapSeconds: 8,
  nightIntervalMinutes: 15,
  nightStartHour: 0,
  nightEndHour: 6,
  timeZone: 'Asia/Shanghai',
};

test('夜间判定支持 0-6 点跨零点', () => {
  assert.equal(isNight(2, 0, 6), true);
  assert.equal(isNight(6, 0, 6), false);
  assert.equal(isNight(14, 0, 6), false);
});

test('夜间判定支持 22-6 点跨零点', () => {
  assert.equal(isNight(23, 22, 6), true);
  assert.equal(isNight(3, 22, 6), true);
  assert.equal(isNight(12, 22, 6), false);
});

test('指数退避翻倍且封顶 24h', () => {
  const base = 5 * 60_000;
  assert.equal(backoffMs(base, 0), base);
  assert.equal(backoffMs(base, 2), base * 4);
  assert.equal(backoffMs(base, 50), 24 * 3_600_000);
});

test('夜间周期放宽为 15 分钟', () => {
  const day = new Date('2026-11-06T14:00:00+08:00');
  const night = new Date('2026-11-06T02:00:00+08:00');
  assert.equal(nextPollDelayMs(polling, 0, day), 5 * 60_000);
  assert.equal(nextPollDelayMs(polling, 0, night), 15 * 60_000);
});

test('Linux 服务器跑 UTC 时，夜间窗口仍按 Asia/Shanghai 判定', () => {
  // 北京时间 02:00 == UTC 前一日 18:00；用 Z 后缀，测试不依赖运行机器本地时区
  const beijingNight = new Date('2026-11-05T18:00:00Z');
  assert.equal(hourInTimeZone(beijingNight, 'Asia/Shanghai'), 2);
  assert.equal(nextPollDelayMs(polling, 0, beijingNight), 15 * 60_000);

  // 北京时间 14:00 == UTC 06:00，属于白天
  const beijingDay = new Date('2026-11-06T06:00:00Z');
  assert.equal(hourInTimeZone(beijingDay, 'Asia/Shanghai'), 14);
  assert.equal(nextPollDelayMs(polling, 0, beijingDay), 5 * 60_000);
});

test('非法时区名退回本地小时，不抛异常', () => {
  const now = new Date('2026-11-06T06:00:00Z');
  assert.equal(hourInTimeZone(now, 'Not/A_Zone'), now.getHours());
});

test('到期判断与账号筛选', () => {
  const now = 1_000_000;
  assert.equal(isDue(undefined, now), true);
  assert.equal(isDue({ sec_user_id: 'a', last_poll_at: 0, next_poll_at: now - 1, fail_streak: 0, last_ok_at: 0 }, now), true);
  assert.equal(isDue({ sec_user_id: 'a', last_poll_at: 0, next_poll_at: now + 1, fail_streak: 0, last_ok_at: 0 }, now), false);

  const accounts = [
    { name: 'A', secUserId: 'a', enabled: true },
    { name: 'B', secUserId: 'b', enabled: false },
    { name: 'C', secUserId: 'c', enabled: true },
  ];
  const states = new Map([['c', { sec_user_id: 'c', last_poll_at: 0, next_poll_at: now + 999, fail_streak: 0, last_ok_at: 0 }]]);
  assert.deepEqual(dueAccounts(accounts, (id) => states.get(id), now).map((a) => a.name), ['A']);
});
