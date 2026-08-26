import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOCUSING_SETTINGS,
  NotificationManager,
  RecentAudioSelector,
  ReminderScheduler,
  WARMUP_SETTINGS,
  getRandomDelay,
  normalizeReminderSettings
} from '../public/js/focus-core.js';

const FIVE_MIN = 5 * 60_000;
const TEN_MIN = 10 * 60_000;

test('focus reminders stay between 5 and 10 minutes', () => {
  const warmup = normalizeReminderSettings(WARMUP_SETTINGS);
  const focusing = normalizeReminderSettings(FOCUSING_SETTINGS);
  assert.equal(warmup.minIntervalMinutes, 5);
  assert.equal(warmup.maxIntervalMinutes, 10);
  assert.equal(focusing.minIntervalMinutes, 5);
  assert.equal(focusing.maxIntervalMinutes, 10);

  for (const random of [0, 0.25, 0.5, 0.9999]) {
    const delay = getRandomDelay(FIVE_MIN, TEN_MIN, () => random);
    assert.ok(delay >= FIVE_MIN);
    assert.ok(delay <= TEN_MIN);
  }
  assert.equal(getRandomDelay(FIVE_MIN, TEN_MIN, () => 0), FIVE_MIN);
  assert.ok(getRandomDelay(FIVE_MIN, TEN_MIN, () => 0.9999) <= TEN_MIN);
  assert.ok(getRandomDelay(FIVE_MIN, TEN_MIN, () => 0.9999) >= FIVE_MIN);
});

test('random delay is always inside the configured range', () => {
  for (const random of [0, 0.25, 0.5, 0.9999]) {
    const delay = getRandomDelay(5_000 * 3, 20_000, () => random);
    assert.ok(delay >= 15_000);
    assert.ok(delay <= 20_000);
  }
});

test('random delay can produce different values', () => {
  const first = getRandomDelay(60_000, 120_000, () => 0.1);
  const second = getRandomDelay(60_000, 120_000, () => 0.9);
  assert.notEqual(first, second);
});

test('settings validate minimum and maximum intervals', () => {
  const settings = normalizeReminderSettings({ minIntervalMinutes: -1, maxIntervalMinutes: 0.1 });
  assert.ok(settings.minIntervalMinutes >= 0.25);
  assert.ok(settings.maxIntervalMinutes > settings.minIntervalMinutes);
});

test('scheduler uses a 5 to 10 minute gap', () => {
  const delays = [];
  const scheduler = new ReminderScheduler({
    getSettings: () => WARMUP_SETTINGS,
    random: () => 0.5,
    setTimer: (_fn, delay) => {
      delays.push(delay);
      return 1;
    },
    clearTimer: () => {},
    onReminder: async () => {}
  });
  scheduler.start();
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= FIVE_MIN);
  assert.ok(delays[0] <= TEN_MIN);
});

test('scheduler reschedules after firing and avoids duplicate timers', async () => {
  const scheduled = [];
  const cleared = [];
  let nextId = 1;
  let reminders = 0;
  const scheduler = new ReminderScheduler({
    getSettings: () => ({ minIntervalMinutes: 1, maxIntervalMinutes: 2 }),
    random: () => 0.5,
    setTimer: (fn, delay) => {
      const id = nextId++;
      scheduled.push({ id, fn, delay });
      return id;
    },
    clearTimer: (id) => cleared.push(id),
    onReminder: async () => {
      reminders += 1;
    }
  });

  scheduler.start();
  scheduler.start();
  assert.equal(scheduled.length, 1);
  assert.deepEqual(cleared, []);
  await scheduled.at(-1).fn();
  assert.equal(reminders, 1);
  assert.equal(scheduled.length, 2);
});

test('paused and ended schedulers do not trigger reminders', async () => {
  const scheduled = [];
  let reminders = 0;
  const scheduler = new ReminderScheduler({
    getSettings: () => ({ minIntervalMinutes: 1, maxIntervalMinutes: 2 }),
    setTimer: (fn) => {
      scheduled.push(fn);
      return scheduled.length;
    },
    clearTimer: () => {},
    onReminder: async () => {
      reminders += 1;
    }
  });

  scheduler.start();
  scheduler.pause();
  await scheduled[0]();
  assert.equal(reminders, 0);

  scheduler.start();
  scheduler.stop();
  await scheduled[1]();
  assert.equal(reminders, 0);
});

test('resume generates a new interval', () => {
  const delays = [];
  let randomValue = 0.1;
  const scheduler = new ReminderScheduler({
    getSettings: () => ({ minIntervalMinutes: 1, maxIntervalMinutes: 2 }),
    random: () => randomValue,
    setTimer: (_fn, delay) => {
      delays.push(delay);
      return delays.length;
    },
    clearTimer: () => {},
    onReminder: async () => {}
  });
  scheduler.start();
  scheduler.pause();
  randomValue = 0.9;
  scheduler.start();
  assert.notEqual(delays[0], delays[1]);
});

test('focus nudge fires halfway between voice reminders', async () => {
  const scheduled = [];
  let voices = 0;
  let nudges = 0;
  const scheduler = new ReminderScheduler({
    getSettings: () => ({ minIntervalMinutes: 1, maxIntervalMinutes: 2 }),
    random: () => 0.5,
    setTimer: (fn, delay) => {
      scheduled.push({ fn, delay });
      return scheduled.length;
    },
    clearTimer: () => {},
    onReminder: async () => {
      voices += 1;
    },
    onFocusNudge: async () => {
      nudges += 1;
    }
  });

  scheduler.start();
  assert.equal(scheduled.length, 2);
  assert.ok(scheduled[1].delay < scheduled[0].delay);
  assert.equal(scheduled[1].delay, Math.floor(scheduled[0].delay / 2));

  await scheduled[1].fn();
  assert.equal(nudges, 1);
  assert.equal(voices, 0);

  await scheduled[0].fn();
  assert.equal(voices, 1);
  assert.equal(scheduled.length, 4);
});

test('paused scheduler does not fire the focus nudge', async () => {
  const scheduled = [];
  let nudges = 0;
  const scheduler = new ReminderScheduler({
    getSettings: () => ({ minIntervalMinutes: 1, maxIntervalMinutes: 2 }),
    setTimer: (fn) => {
      scheduled.push(fn);
      return scheduled.length;
    },
    clearTimer: () => {},
    onReminder: async () => {},
    onFocusNudge: async () => {
      nudges += 1;
    }
  });

  scheduler.start();
  scheduler.pause();
  await scheduled[1]();
  assert.equal(nudges, 0);
});

test('audio selector avoids immediate repetition when alternatives exist', () => {
  const items = [
    { id: 'a', category: 'GENERAL', enabled: true },
    { id: 'b', category: 'GENERAL', enabled: true }
  ];
  const selector = new RecentAudioSelector({ historySize: 1, random: () => 0 });
  const first = selector.select(items);
  const second = selector.select(items);
  assert.equal(first.id, 'a');
  assert.equal(second.id, 'b');
});

test('audio selector handles empty and single-item libraries', () => {
  const selector = new RecentAudioSelector({ historySize: 3, random: () => 0 });
  assert.equal(selector.select([]), null);
  const only = { id: 'solo', category: 'GENERAL', enabled: true };
  assert.equal(selector.select([only]).id, 'solo');
  assert.equal(selector.select([only]).id, 'solo');
});

test('audio selector ignores disabled audio', () => {
  const selector = new RecentAudioSelector({ random: () => 0 });
  assert.equal(selector.select([{ id: 'x', enabled: false }]), null);
});

test('notification manager handles disabled, denied, granted, and unsupported states', async () => {
  assert.equal(new NotificationManager(undefined).permission(), 'unsupported');
  let shown = 0;
  class FakeNotification {
    static permission = 'denied';
    static async requestPermission() {
      return 'denied';
    }
    constructor() {
      shown += 1;
    }
  }
  const denied = new NotificationManager(FakeNotification);
  assert.equal(await denied.requestPermission(), 'denied');
  assert.equal(denied.show(), false);
  FakeNotification.permission = 'granted';
  assert.equal(denied.show(), true);
  assert.equal(shown, 1);
});
