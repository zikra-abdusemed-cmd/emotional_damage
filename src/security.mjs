import { createId } from './db.mjs';
import { jsonError } from './validation.mjs';

export const PROFILE_COOKIE = 'ed_profile';
const PROFILE_ID = /^profile_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TASK_ID = /^task_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIO_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_URL_LENGTH = 2048;

export function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value when it is not URI-encoded
    }
    cookies.set(name, value);
  }
  return cookies;
}

export function isProfileId(value) {
  return PROFILE_ID.test(String(value || ''));
}

export function isTaskId(value) {
  return TASK_ID.test(String(value || ''));
}

export function isAudioId(value) {
  return AUDIO_ID.test(String(value || ''));
}

export function isHttps(req) {
  if (process.env.SECURE_COOKIES === '1') return true;
  if (req?.socket?.encrypted) return true;
  if (process.env.TRUST_PROXY === '1') {
    const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
    return proto === 'https';
  }
  return false;
}

export function resolveProfile(req) {
  const existing = parseCookies(req.headers.cookie).get(PROFILE_COOKIE);
  if (isProfileId(existing)) {
    return { id: existing, isNew: false };
  }
  return { id: createId('profile'), isNew: true };
}

export function profileCookie(profileId, req) {
  const parts = [
    `${PROFILE_COOKIE}=${profileId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=31536000'
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

export function securityHeaders(req) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-permitted-cross-domain-policies': 'none',
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "media-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'"
    ].join('; ')
  };
  if (isHttps(req)) {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

export function cacheControlFor(filePath) {
  if (/\.html$/i.test(filePath)) return 'no-store';
  if (/\.(css|js)$/i.test(filePath)) return 'no-cache';
  return 'private, max-age=3600';
}

export function assertSafeUrl(req) {
  const raw = String(req.url || '');
  if (raw.length > MAX_URL_LENGTH || raw.includes('\0')) {
    throw jsonError('Not found.', 404, 'NOT_FOUND');
  }
}

export function assertSameOrigin(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw jsonError('Forbidden.', 403, 'FORBIDDEN');
  }
  const host = String(req.headers.host || '');
  if (!host || parsed.host !== host) {
    throw jsonError('Forbidden.', 403, 'FORBIDDEN');
  }
}

export function assertJsonContentType(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const length = Number(req.headers['content-length'] || 0);
  if (!type && (!Number.isFinite(length) || length === 0)) return;
  if (type === 'application/json') return;
  throw jsonError('Unsupported content type.', 415, 'UNSUPPORTED_MEDIA_TYPE');
}

export function needsLegacyAdoption(data, profileId) {
  const hasProfile = data.tasks.some((item) => item.userId === profileId)
    || data.focusSessions.some((item) => item.userId === profileId);
  if (hasProfile) return false;
  const foreign = data.tasks.some((item) => item.userId && item.userId !== 'local-user')
    || data.focusSessions.some((item) => item.userId && item.userId !== 'local-user');
  if (foreign) return false;
  return data.tasks.length > 0 || data.focusSessions.length > 0;
}

export function adoptLegacyUser(data, profileId) {
  if (!needsLegacyAdoption(data, profileId)) return data;
  for (const task of data.tasks) task.userId = profileId;
  for (const session of data.focusSessions) session.userId = profileId;
  return data;
}

export function pruneStore(data, { maxCompleted = 500, maxEndedSessions = 40 } = {}) {
  const taskGroups = new Map();
  for (const task of data.tasks) {
    const key = task.userId || 'unknown';
    if (!taskGroups.has(key)) taskGroups.set(key, []);
    taskGroups.get(key).push(task);
  }
  data.tasks = [...taskGroups.values()].flatMap((tasks) => {
    const open = tasks.filter((task) => !task.completed);
    const completed = tasks
      .filter((task) => task.completed)
      .sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')))
      .slice(0, maxCompleted);
    return [...open, ...completed];
  });

  const sessionGroups = new Map();
  for (const session of data.focusSessions) {
    const key = session.userId || 'unknown';
    if (!sessionGroups.has(key)) sessionGroups.set(key, []);
    sessionGroups.get(key).push(session);
  }
  data.focusSessions = [...sessionGroups.values()].flatMap((sessions) => {
    const active = sessions.filter((session) => ['FOCUSING', 'PAUSED'].includes(session.status));
    const ended = sessions
      .filter((session) => !['FOCUSING', 'PAUSED'].includes(session.status))
      .slice(-maxEndedSessions);
    return [...ended, ...active];
  });
  return data;
}
