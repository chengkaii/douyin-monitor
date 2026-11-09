import test from 'node:test';
import assert from 'node:assert/strict';
import { isNight, backoffMs, nextPollDelayMs, dueAccounts, isDue } from '../src/scheduler.js';
import type { PollingConfig } from '../src/types.js';

const polling: PollingConfig = {
  intervalMinutes: 5,
  jitterSeconds: 0,
  minGapSeconds: 8,
  nightIntervalMinutes: 15,
  nightStartHour: 0,
  nightEndHour: 6,
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
  const day = new Date('2026-11-06T14:00:00');
  const night = new Date('2026-11-06T02:00:00');
  assert.equal(nextPollDelayMs(polling, 0, day), 5 * 60_000);
  assert.equal(nextPollDelayMs(polling, 0, night), 15 * 60_000);
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
