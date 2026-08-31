import { nowIso } from './db.mjs';
import { isProfileId } from './security.mjs';

export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const PRESENCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PRESENCE = 8000;

export function clampCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number));
}

export function emptyStats() {
  return {
    visitors: 0,
    completed: 0,
    lastSeen: {}
  };
}

export function ensureStats(data) {
  if (!data.stats || typeof data.stats !== 'object' || Array.isArray(data.stats)) {
    data.stats = emptyStats();
  }
  if (!data.stats.lastSeen || typeof data.stats.lastSeen !== 'object' || Array.isArray(data.stats.lastSeen)) {
    data.stats.lastSeen = {};
  }
  data.stats.visitors = clampCount(data.stats.visitors);
  data.stats.completed = clampCount(data.stats.completed);
  return data.stats;
}

export function prunePresence(lastSeen, now = Date.now()) {
  const entries = Object.entries(lastSeen || {}).filter(([id, iso]) => {
    if (!isProfileId(id)) return false;
    const time = Date.parse(iso);
    return Number.isFinite(time) && now - time <= PRESENCE_TTL_MS;
  });
  entries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
  const next = {};
  for (const [id, iso] of entries.slice(0, MAX_PRESENCE)) next[id] = iso;
  return next;
}

export function publicStats(data, now = Date.now()) {
  const stats = ensureStats(data);
  let activeUsers = 0;
  for (const iso of Object.values(stats.lastSeen)) {
    const time = Date.parse(iso);
    if (Number.isFinite(time) && now - time <= ACTIVE_WINDOW_MS) activeUsers += 1;
  }
  return {
    visitors: stats.visitors,
    activeUsers,
    crossedOff: stats.completed
  };
}

export function applyVisit(data, userId, { countVisitor = false, present = true } = {}, at = nowIso()) {
  const stats = ensureStats(data);
  if (countVisitor) stats.visitors = clampCount(stats.visitors + 1);
  if (present && isProfileId(userId)) stats.lastSeen[userId] = at;
  stats.lastSeen = prunePresence(stats.lastSeen, Date.parse(at) || Date.now());
  return publicStats(data, Date.parse(at) || Date.now());
}

export function applyCompletion(data) {
  const stats = ensureStats(data);
  stats.completed = clampCount(stats.completed + 1);
  return stats.completed;
}
