import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCompletion, applyVisit, publicStats } from '../src/stats.mjs';

const profileA = 'profile_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const profileB = 'profile_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('public stats never include presence records', () => {
  const data = {
    stats: {
      visitors: 4,
      completed: 9,
      lastSeen: { [profileA]: new Date().toISOString() }
    }
  };
  const payload = publicStats(data);
  assert.deepEqual(Object.keys(payload).sort(), ['activeUsers', 'crossedOff', 'visitors']);
  assert.equal(payload.visitors, 4);
  assert.equal(payload.crossedOff, 9);
  assert.equal(payload.activeUsers, 1);
});

test('unique visitors increment once and active users follow recent presence', () => {
  const data = { stats: { visitors: 0, completed: 0, lastSeen: {} } };
  const first = applyVisit(data, profileA, { countVisitor: true, present: true });
  const second = applyVisit(data, profileA, { countVisitor: false, present: true });
  assert.equal(first.visitors, 1);
  assert.equal(second.visitors, 1);
  applyVisit(data, profileB, { countVisitor: true, present: true });
  assert.equal(publicStats(data).visitors, 2);
  assert.equal(publicStats(data).activeUsers, 2);
});

test('crossed-off count is cumulative', () => {
  const data = { stats: { visitors: 0, completed: 0, lastSeen: {} } };
  applyCompletion(data);
  applyCompletion(data);
  assert.equal(publicStats(data).crossedOff, 2);
});
