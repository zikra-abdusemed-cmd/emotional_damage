export const SESSION_STATUSES = Object.freeze({
  IDLE: 'IDLE',
  FOCUSING: 'FOCUSING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  ENDED: 'ENDED'
});

export const WARMUP_SETTINGS = Object.freeze({
  minIntervalMinutes: 5,
  maxIntervalMinutes: 10,
  audioEnabled: true,
  volume: 0.85,
  avoidRecentAudio: true
});

export const FOCUSING_SETTINGS = Object.freeze({
  minIntervalMinutes: 5,
  maxIntervalMinutes: 10,
  audioEnabled: true,
  volume: 0.85,
  avoidRecentAudio: true
});

const MIN_ALLOWED_MS = 15 * 1000;
const MAX_ALLOWED_MS = 60 * 60 * 1000;

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeReminderSettings(settings = {}) {
  const minMinutes = clampNumber(
    settings.minIntervalMinutes,
    MIN_ALLOWED_MS / 60000,
    MAX_ALLOWED_MS / 60000,
    WARMUP_SETTINGS.minIntervalMinutes
  );
  const maxMinutes = clampNumber(
    settings.maxIntervalMinutes,
    MIN_ALLOWED_MS / 60000,
    MAX_ALLOWED_MS / 60000,
    WARMUP_SETTINGS.maxIntervalMinutes
  );
  const normalized = {
    minIntervalMinutes: Math.min(minMinutes, maxMinutes),
    maxIntervalMinutes: Math.max(minMinutes, maxMinutes),
    audioEnabled: settings.audioEnabled !== false,
    volume: clampNumber(settings.volume, 0, 1, WARMUP_SETTINGS.volume),
    avoidRecentAudio: settings.avoidRecentAudio !== false
  };

  if (normalized.minIntervalMinutes === normalized.maxIntervalMinutes) {
    normalized.maxIntervalMinutes = Math.min(60, normalized.minIntervalMinutes + 1);
    if (normalized.maxIntervalMinutes === normalized.minIntervalMinutes) {
      normalized.minIntervalMinutes = Math.max(0.25, normalized.maxIntervalMinutes - 1);
    }
  }

  return normalized;
}

export function getRandomDelay(minMs, maxMs, random = Math.random) {
  const min = Math.ceil(clampNumber(minMs, MIN_ALLOWED_MS, MAX_ALLOWED_MS, MIN_ALLOWED_MS));
  const max = Math.floor(clampNumber(maxMs, MIN_ALLOWED_MS, MAX_ALLOWED_MS, MAX_ALLOWED_MS));
  if (min >= max) {
    throw new Error('Minimum reminder interval must be less than maximum reminder interval.');
  }
  const value = Math.floor(random() * (max - min + 1) + min);
  return Math.min(max, Math.max(min, value));
}

export class RecentAudioSelector {
  constructor({ historySize = 3, random = Math.random } = {}) {
    this.historySize = Math.max(1, historySize);
    this.random = random;
    this.recentAudioIds = [];
  }

  select(audioItems, categories = [], avoidRecent = true) {
    const enabled = audioItems.filter((audio) => audio && audio.enabled !== false);
    const wanted = categories.length
      ? enabled.filter((audio) => categories.includes(audio.category))
      : enabled;
    const pool = wanted.length ? wanted : enabled;
    if (pool.length === 0) return null;

    let candidates = pool;
    if (avoidRecent && pool.length > 1) {
      const recent = new Set(this.recentAudioIds);
      const fresh = pool.filter((audio) => !recent.has(audio.id));
      if (fresh.length > 0) candidates = fresh;
    }

    const index = Math.floor(this.random() * candidates.length);
    const selected = candidates[index];
    this.remember(selected.id);
    return selected;
  }

  remember(id) {
    if (!id) return;
    this.recentAudioIds = [id, ...this.recentAudioIds.filter((item) => item !== id)].slice(0, this.historySize);
  }
}

export class ReminderScheduler {
  constructor({
    onReminder,
    onFocusNudge,
    getSettings,
    random = Math.random,
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis)
  }) {
    this.onReminder = onReminder;
    this.onFocusNudge = onFocusNudge;
    this.getSettings = getSettings;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timerId = null;
    this.nudgeTimerId = null;
    this.running = false;
    this.lastDelayMs = null;
  }

  start() {
    if (this.running && this.timerId !== null) return;
    this.running = true;
    this.scheduleNext();
  }

  scheduleNext() {
    this.cancel();
    if (!this.running) return null;
    const settings = normalizeReminderSettings(this.getSettings());
    const delay = getRandomDelay(
      settings.minIntervalMinutes * 60000,
      settings.maxIntervalMinutes * 60000,
      this.random
    );
    this.lastDelayMs = delay;
    this.timerId = this.setTimer(async () => {
      this.timerId = null;
      this.cancelNudge();
      if (!this.running) return;
      await this.onReminder();
      if (this.running) this.scheduleNext();
    }, delay);

    const nudgeDelay = Math.floor(delay / 2);
    if (this.onFocusNudge && nudgeDelay > 0 && nudgeDelay < delay) {
      this.nudgeTimerId = this.setTimer(async () => {
        this.nudgeTimerId = null;
        if (!this.running) return;
        await this.onFocusNudge();
      }, nudgeDelay);
    }
    return delay;
  }

  pause() {
    this.running = false;
    this.cancel();
  }

  stop() {
    this.running = false;
    this.cancel();
  }

  cancel() {
    if (this.timerId !== null) {
      this.clearTimer(this.timerId);
      this.timerId = null;
    }
    this.cancelNudge();
  }

  cancelNudge() {
    if (this.nudgeTimerId !== null) {
      this.clearTimer(this.nudgeTimerId);
      this.nudgeTimerId = null;
    }
  }
}

export class NotificationManager {
  constructor(notificationApi = globalThis.Notification) {
    this.NotificationApi = notificationApi;
  }

  isSupported() {
    return typeof this.NotificationApi !== 'undefined';
  }

  permission() {
    if (!this.isSupported()) return 'unsupported';
    return this.NotificationApi.permission;
  }

  async requestPermission() {
    if (!this.isSupported()) return 'unsupported';
    if (this.NotificationApi.permission === 'granted') return 'granted';
    if (this.NotificationApi.permission === 'denied') return 'denied';
    return this.NotificationApi.requestPermission();
  }

  show({ title = 'Focus Reminder', body = 'Get back to your task.', tag = 'emotional-damage' } = {}) {
    if (!this.isSupported() || this.NotificationApi.permission !== 'granted') return false;
    const notification = new this.NotificationApi(title, {
      body,
      tag,
      silent: false,
      renotify: true
    });
    if (typeof notification.addEventListener === 'function') {
      notification.addEventListener('click', () => {
        globalThis.focus?.();
        notification.close?.();
      });
    }
    return true;
  }
}

export function elapsedSeconds(startedAt, pausedAt = null, now = Date.now()) {
  if (!startedAt) return 0;
  const end = pausedAt ? Date.parse(pausedAt) : now;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 1000));
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(remainingSeconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${minutes}:${ss}`;
}
