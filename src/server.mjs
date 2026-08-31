import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { JsonDatabase, createId, nowIso } from './db.mjs';
import { LocalAudioStorage } from './storage.mjs';
import {
  jsonError,
  normalizeBoolean,
  normalizeTitle,
  parseJsonBody
} from './validation.mjs';
import { nextIncompleteTask, normalizeTaskPositions, reorderTasks, sortTasks } from './tasks.mjs';
import { applyCompletion, applyVisit } from './stats.mjs';
import {
  adoptLegacyUser,
  assertJsonContentType,
  assertSafeUrl,
  assertSameOrigin,
  cacheControlFor,
  isAudioId,
  isHttps,
  isTaskId,
  needsLegacyAdoption,
  profileCookie,
  pruneStore,
  resolveProfile,
  securityHeaders
} from './security.mjs';

const rootDir = resolve(process.cwd());
const publicDir = resolve(join(rootDir, 'public'));
const db = new JsonDatabase(process.env.DB_FILE || join(rootDir, 'data', 'db.json'));
const storage = new LocalAudioStorage(process.env.AUDIO_DIR || join(rootDir, 'audio'));
const preferredPort = Number(process.env.PORT) || 3000;
const portIsFixed = process.env.PORT !== undefined && process.env.PORT !== '';
const host = process.env.HOST || '0.0.0.0';
let port = preferredPort;

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

const pageRoutes = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app', 'app.html'],
  ['/app/', 'app.html'],
  ['/app.html', 'app.html']
]);

const rateBuckets = new Map();

function checkRateLimit(req, limit = 120, windowMs = 60_000) {
  const key = req.socket.remoteAddress || 'local';
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > limit) {
    throw jsonError('Too many requests. Please slow down.', 429, 'RATE_LIMITED');
  }
}

function applyHeaders(req, extra = {}) {
  const headers = { ...securityHeaders(req), ...extra };
  if (req.profileId) {
    headers['set-cookie'] = profileCookie(req.profileId, req);
  }
  return headers;
}

function sendJson(res, req, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, applyHeaders(req, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  }));
  res.end(body);
}

function sendError(res, req, error) {
  const status = error.status || 500;
  sendJson(res, req, {
    error: {
      code: error.code || 'SERVER_ERROR',
      message: status === 500 ? 'Unexpected server error.' : error.message
    }
  }, status);
  if (status === 500) console.error(error);
}

function resolvePublicFile(relativePath) {
  const normalized = String(relativePath || '').replace(/^\/+/, '');
  const filePath = resolve(join(publicDir, normalized));
  const prefix = publicDir.endsWith(sep) ? publicDir : `${publicDir}${sep}`;
  if (filePath !== publicDir && !filePath.startsWith(prefix)) {
    throw jsonError('Not found.', 404, 'NOT_FOUND');
  }
  return filePath;
}

async function sendPublicFile(res, req, relativePath) {
  const filePath = resolvePublicFile(relativePath);
  const info = await stat(filePath);
  if (!info.isFile()) throw jsonError('Not found.', 404, 'NOT_FOUND');
  const body = await readFile(filePath);
  res.writeHead(200, applyHeaders(req, {
    'content-type': mimeTypes.get(extname(filePath)) || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': cacheControlFor(filePath)
  }));
  res.end(body);
}

function publicAudio(audio) {
  return {
    id: audio.id,
    name: audio.name,
    category: audio.category,
    duration: audio.duration,
    mimeType: audio.mimeType,
    enabled: audio.enabled,
    createdAt: audio.createdAt,
    updatedAt: audio.updatedAt,
    streamUrl: `/api/audio/${audio.id}/file`
  };
}

function activeSession(data, userId) {
  return data.focusSessions.find((session) => (
    session.userId === userId && ['FOCUSING', 'PAUSED'].includes(session.status)
  )) || null;
}

function shiftIso(iso, deltaMs) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Date(time + deltaMs).toISOString();
}

function serializeCurrent(data, userId) {
  const session = activeSession(data, userId);
  const tasks = sortTasks(data.tasks.filter((task) => task.userId === userId));
  const activeTask = session ? tasks.find((task) => task.id === session.activeTaskId) || null : null;
  return {
    session,
    activeTask,
    tasks
  };
}

async function mutateDb(userId, mutator) {
  return db.update((data) => {
    adoptLegacyUser(data, userId);
    const result = mutator(data);
    pruneStore(data);
    return result;
  });
}

async function touchPresence(userId, { countVisitor = false, present = true } = {}) {
  return db.update((data) => applyVisit(data, userId, { countVisitor, present }));
}

async function readProfile(userId, reader) {
  const data = await db.read();
  if (needsLegacyAdoption(data, userId)) {
    return mutateDb(userId, reader);
  }
  return reader(data);
}

async function handleTasks(req, res, url, userId) {
  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const tasks = await readProfile(userId, (data) => (
      sortTasks(data.tasks.filter((task) => task.userId === userId))
    ));
    sendJson(res, req, { tasks });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await parseJsonBody(req);
    const title = normalizeTitle(body.title ?? body.text);
    const result = await mutateDb(userId, (data) => {
      const userTasks = data.tasks.filter((item) => item.userId === userId);
      const created = {
        id: createId('task'),
        userId,
        title,
        position: userTasks.filter((item) => !item.completed).length + 1,
        completed: false,
        createdAt: nowIso(),
        completedAt: null
      };
      data.tasks.push(created);
      data.tasks = normalizeTaskPositions(data.tasks);
      return {
        task: created,
        current: serializeCurrent(data, userId)
      };
    });
    sendJson(res, req, result, 201);
    return true;
  }

  if (req.method === 'PATCH' && url.pathname === '/api/tasks/reorder') {
    const body = await parseJsonBody(req);
    const orderedIds = Array.isArray(body.orderedIds)
      ? body.orderedIds
      : Array.isArray(body.ids) ? body.ids : [];
    if (orderedIds.some((id) => !isTaskId(id))) {
      throw jsonError('Invalid task id.', 400, 'INVALID_TASK_ID');
    }
    const tasks = await mutateDb(userId, (data) => {
      const mine = data.tasks.filter((task) => task.userId === userId);
      const other = data.tasks.filter((task) => task.userId !== userId);
      const reordered = reorderTasks(mine, orderedIds);
      data.tasks = [...other, ...reordered];
      return sortTasks(reordered);
    });
    sendJson(res, req, { tasks });
    return true;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (!taskMatch) return false;
  const id = taskMatch[1];
  if (!isTaskId(id)) throw jsonError('Task not found.', 404, 'TASK_NOT_FOUND');

  if (req.method === 'PATCH') {
    const body = await parseJsonBody(req);
    const result = await mutateDb(userId, (data) => {
      const task = data.tasks.find((item) => item.id === id && item.userId === userId);
      if (!task) throw jsonError('Task not found.', 404, 'TASK_NOT_FOUND');
      if (body.title !== undefined) task.title = normalizeTitle(body.title);
      if (body.completed !== undefined) {
        const completed = normalizeBoolean(body.completed);
        const wasCompleted = Boolean(task.completed);
        task.completed = completed;
        task.completedAt = completed ? nowIso() : null;
        if (completed && !wasCompleted) applyCompletion(data);
      }

      const session = activeSession(data, userId);
      if (session && session.activeTaskId === task.id && task.completed) {
        const next = nextIncompleteTask(data.tasks.filter((item) => item.userId === userId && item.id !== task.id));
        session.activeTaskId = next?.id || null;
        session.currentTaskStartedAt = next ? nowIso() : session.currentTaskStartedAt;
        session.status = next ? session.status : 'COMPLETED';
        if (!next) session.endedAt = nowIso();
      }

      data.tasks = normalizeTaskPositions(data.tasks);
      return {
        task,
        current: serializeCurrent(data, userId)
      };
    });
    sendJson(res, req, result);
    return true;
  }

  return false;
}

async function handleFocus(req, res, url, userId) {
  if (req.method === 'GET' && url.pathname === '/api/focus/current') {
    await touchPresence(userId, { present: true });
    const current = await readProfile(userId, (data) => serializeCurrent(data, userId));
    sendJson(res, req, current);
    return true;
  }

  if (!url.pathname.startsWith('/api/focus/')) return false;
  if (req.method !== 'POST') return false;

  const action = url.pathname.split('/').pop();
  await parseJsonBody(req);
  const current = await mutateDb(userId, (data) => {
    const existing = activeSession(data, userId);
    const now = nowIso();

    if (action === 'start') {
      if (existing) {
        existing.status = 'ENDED';
        existing.endedAt = now;
      }
      const task = nextIncompleteTask(data.tasks.filter((item) => item.userId === userId));
      if (!task) throw jsonError('Add an incomplete task before starting focus.', 409, 'NO_TASKS');
      const session = {
        id: createId('session'),
        userId,
        status: 'FOCUSING',
        activeTaskId: task.id,
        startedAt: now,
        currentTaskStartedAt: now,
        pausedAt: null,
        endedAt: null,
        lastReminderAt: null
      };
      data.focusSessions.push(session);
      return serializeCurrent(data, userId);
    }

    if (!existing) throw jsonError('No active focus session.', 409, 'NO_ACTIVE_SESSION');

    if (action === 'pause') {
      existing.status = 'PAUSED';
      existing.pausedAt = now;
      return serializeCurrent(data, userId);
    }

    if (action === 'resume') {
      const task = data.tasks.find((item) => item.id === existing.activeTaskId && item.userId === userId && !item.completed);
      if (!task) throw jsonError('No active incomplete task to resume.', 409, 'NO_ACTIVE_TASK');
      if (existing.pausedAt) {
        const parsedPause = Date.parse(existing.pausedAt);
        const pausedForMs = Number.isFinite(parsedPause) ? Math.max(0, Date.parse(now) - parsedPause) : 0;
        existing.currentTaskStartedAt = shiftIso(existing.currentTaskStartedAt, pausedForMs);
      }
      existing.status = 'FOCUSING';
      existing.pausedAt = null;
      return serializeCurrent(data, userId);
    }

    if (action === 'end') {
      existing.status = 'ENDED';
      existing.endedAt = now;
      existing.pausedAt = null;
      return serializeCurrent(data, userId);
    }

    throw jsonError('Unknown focus action.', 404, 'NOT_FOUND');
  });
  sendJson(res, req, current);
  return true;
}

async function handleStats(req, res, url, userId) {
  if (url.pathname !== '/api/stats') return false;
  if (req.method !== 'GET') throw jsonError('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  const payload = await touchPresence(userId, { present: true });
  sendJson(res, req, payload);
  return true;
}

async function handleAudio(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/audio') {
    const audio = await storage.listManualFiles();
    sendJson(res, req, {
      audio: audio.map(publicAudio),
      count: audio.length
    });
    return true;
  }

  const fileMatch = url.pathname.match(/^\/api\/audio\/([^/]+)\/file$/);
  if (fileMatch && req.method === 'GET') {
    if (!isAudioId(fileMatch[1])) throw jsonError('Audio not found.', 404, 'AUDIO_NOT_FOUND');
    const audio = await storage.manualFileById(fileMatch[1]);
    if (!audio) throw jsonError('Audio not found.', 404, 'AUDIO_NOT_FOUND');
    res.writeHead(200, applyHeaders(req, {
      'content-type': audio.mimeType,
      'cache-control': 'private, max-age=3600'
    }));
    storage.streamManualFile(audio.filename).pipe(res);
    return true;
  }

  return false;
}

async function serveStatic(req, res, url, profile) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw jsonError('Not found.', 404, 'NOT_FOUND');
  }

  const pageFile = pageRoutes.get(pathname);
  if (pageFile) {
    await touchPresence(profile.id, { countVisitor: profile.isNew, present: true });
    await sendPublicFile(res, req, pageFile);
    return;
  }

  if (/^\/(css|js)\/[^./][^/]*$/.test(pathname)) {
    await sendPublicFile(res, req, pathname);
    return;
  }

  throw jsonError('Not found.', 404, 'NOT_FOUND');
}

const server = createServer(async (req, res) => {
  try {
    assertSafeUrl(req);
    assertSameOrigin(req);
    const method = String(req.method || 'GET').toUpperCase();
    checkRateLimit(req, method === 'GET' || method === 'HEAD' ? 180 : 60);
    const profile = resolveProfile(req);
    req.profileId = profile.id;
    req.profileIsNew = profile.isNew;
    if (method === 'OPTIONS') {
      res.writeHead(204, applyHeaders(req, { allow: 'GET, HEAD, POST, PATCH, OPTIONS' }));
      res.end();
      return;
    }
    let url;
    try {
      const originBase = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host || '127.0.0.1'}`;
      url = new URL(req.url, originBase);
    } catch {
      throw jsonError('Not found.', 404, 'NOT_FOUND');
    }
    if (url.pathname.startsWith('/api/')) assertJsonContentType(req);
    if (
      (await handleTasks(req, res, url, profile.id)) ||
      (await handleFocus(req, res, url, profile.id)) ||
      (await handleStats(req, res, url, profile.id)) ||
      (await handleAudio(req, res, url))
    ) {
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      throw jsonError('Route not found.', 404, 'NOT_FOUND');
    }
    await serveStatic(req, res, url, profile);
  } catch (error) {
    if (!res.headersSent) sendError(res, req, error);
    else req.destroy(error);
  }
});

export { server, port, host, publicDir };

const passenger = globalThis.PhusionPassenger;
const underPassenger = passenger !== undefined;

function tryListen(candidatePort) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve(candidatePort);
    };
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(candidatePort, host);
  });
}

async function startServer() {
  if (underPassenger) {
    passenger.configure({ autoInstall: false });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen('passenger', resolve);
    });
    console.log('Do the Damn Thing running behind Passenger');
    return;
  }

  const maxPort = portIsFixed ? preferredPort : preferredPort + 99;

  for (let candidate = preferredPort; candidate <= maxPort; candidate += 1) {
    try {
      port = await tryListen(candidate);
      if (candidate !== preferredPort) {
        console.warn(`Port ${preferredPort} was in use; using ${port} instead.`);
      }
      console.log(`Do the Damn Thing running at http://${host}:${port}`);
      console.log(`Landing page: http://${host}:${port}/`);
      console.log(`App:          http://${host}:${port}/app`);
      return;
    } catch (error) {
      if (error.code === 'EADDRINUSE' && !portIsFixed) continue;
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${preferredPort} is already in use.`);
        console.error('Stop the other process or set PORT to an open port, e.g. PORT=8080 npm start');
        process.exit(1);
      }
      throw error;
    }
  }

  console.error(`No open port found between ${preferredPort} and ${maxPort}.`);
  console.error('Set PORT to an open port, e.g. PORT=8080 npm start');
  process.exit(1);
}

if (process.env.NODE_TEST !== '1') {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
