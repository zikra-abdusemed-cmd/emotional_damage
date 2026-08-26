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

const rootDir = resolve(process.cwd());
const publicDir = resolve(join(rootDir, 'public'));
const db = new JsonDatabase(process.env.DB_FILE || join(rootDir, 'data', 'db.json'));
const storage = new LocalAudioStorage(process.env.AUDIO_DIR || join(rootDir, 'audio'));
const userId = 'local-user';
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

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, error) {
  const status = error.status || 500;
  sendJson(res, {
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

async function sendPublicFile(res, relativePath) {
  const filePath = resolvePublicFile(relativePath);
  const info = await stat(filePath);
  if (!info.isFile()) throw jsonError('Not found.', 404, 'NOT_FOUND');
  const body = await readFile(filePath);
  res.writeHead(200, {
    'content-type': mimeTypes.get(extname(filePath)) || 'application/octet-stream',
    'content-length': body.length,
    'x-content-type-options': 'nosniff'
  });
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

function activeSession(data) {
  return data.focusSessions.find((session) => ['FOCUSING', 'PAUSED'].includes(session.status)) || null;
}

function shiftIso(iso, deltaMs) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Date(time + deltaMs).toISOString();
}

function serializeCurrent(data) {
  const session = activeSession(data);
  const tasks = sortTasks(data.tasks.filter((task) => task.userId === userId));
  const activeTask = session ? tasks.find((task) => task.id === session.activeTaskId) || null : null;
  return {
    session,
    activeTask,
    tasks
  };
}

async function handleTasks(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const data = await db.read();
    sendJson(res, { tasks: sortTasks(data.tasks.filter((task) => task.userId === userId)) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await parseJsonBody(req);
    const title = normalizeTitle(body.title ?? body.text);
    const result = await db.update((data) => {
      const userTasks = data.tasks.filter((item) => item.userId === userId);
      const created = {
        id: createId('task'),
        userId,
        title,
        position: userTasks.length + 1,
        completed: false,
        createdAt: nowIso(),
        completedAt: null
      };
      data.tasks.push(created);
      data.tasks = normalizeTaskPositions(data.tasks);
      return {
        task: created,
        current: serializeCurrent(data)
      };
    });
    sendJson(res, result, 201);
    return true;
  }

  if (req.method === 'PATCH' && url.pathname === '/api/tasks/reorder') {
    const body = await parseJsonBody(req);
    const tasks = await db.update((data) => {
      const mine = data.tasks.filter((task) => task.userId === userId);
      const other = data.tasks.filter((task) => task.userId !== userId);
      const reordered = reorderTasks(mine, body.orderedIds || body.ids || []);
      data.tasks = [...other, ...reordered];
      return sortTasks(reordered);
    });
    sendJson(res, { tasks });
    return true;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (!taskMatch) return false;
  const id = taskMatch[1];

  if (req.method === 'PATCH') {
    const body = await parseJsonBody(req);
    const result = await db.update((data) => {
      const task = data.tasks.find((item) => item.id === id && item.userId === userId);
      if (!task) throw jsonError('Task not found.', 404, 'TASK_NOT_FOUND');
      if (body.title !== undefined) task.title = normalizeTitle(body.title);
      if (body.completed !== undefined) {
        const completed = normalizeBoolean(body.completed);
        task.completed = completed;
        task.completedAt = completed ? nowIso() : null;
      }

      const session = activeSession(data);
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
        current: serializeCurrent(data)
      };
    });
    sendJson(res, result);
    return true;
  }

  return false;
}

async function handleFocus(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/focus/current') {
    sendJson(res, serializeCurrent(await db.read()));
    return true;
  }

  if (!url.pathname.startsWith('/api/focus/')) return false;
  if (req.method !== 'POST') return false;

  const action = url.pathname.split('/').pop();
  const body = await parseJsonBody(req);
  const current = await db.update((data) => {
    const existing = activeSession(data);
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
        lastReminderAt: null,
        settings: body.settings || {}
      };
      data.focusSessions.push(session);
      return serializeCurrent(data);
    }

    if (!existing) throw jsonError('No active focus session.', 409, 'NO_ACTIVE_SESSION');

    if (action === 'pause') {
      existing.status = 'PAUSED';
      existing.pausedAt = now;
      return serializeCurrent(data);
    }

    if (action === 'resume') {
      const task = data.tasks.find((item) => item.id === existing.activeTaskId && !item.completed);
      if (!task) throw jsonError('No active incomplete task to resume.', 409, 'NO_ACTIVE_TASK');
      if (existing.pausedAt) {
        const parsedPause = Date.parse(existing.pausedAt);
        const pausedForMs = Number.isFinite(parsedPause) ? Math.max(0, Date.parse(now) - parsedPause) : 0;
        existing.currentTaskStartedAt = shiftIso(existing.currentTaskStartedAt, pausedForMs);
      }
      existing.status = 'FOCUSING';
      existing.pausedAt = null;
      existing.settings = body.settings || existing.settings || {};
      return serializeCurrent(data);
    }

    if (action === 'end') {
      existing.status = 'ENDED';
      existing.endedAt = now;
      existing.pausedAt = null;
      return serializeCurrent(data);
    }

    throw jsonError('Unknown focus action.', 404, 'NOT_FOUND');
  });
  sendJson(res, current);
  return true;
}

async function handleAudio(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/audio') {
    const audio = await storage.listManualFiles();
    sendJson(res, {
      audio: audio.map(publicAudio),
      count: audio.length
    });
    return true;
  }

  const fileMatch = url.pathname.match(/^\/api\/audio\/([^/]+)\/file$/);
  if (fileMatch && req.method === 'GET') {
    const audio = await storage.manualFileById(fileMatch[1]);
    if (!audio) throw jsonError('Audio not found.', 404, 'AUDIO_NOT_FOUND');
    res.writeHead(200, {
      'content-type': audio.mimeType,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff'
    });
    storage.streamManualFile(audio.filename).pipe(res);
    return true;
  }

  return false;
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);

  const pageFile = pageRoutes.get(pathname);
  if (pageFile) {
    await sendPublicFile(res, pageFile);
    return;
  }

  if (/^\/(css|js)\/.+/.test(pathname)) {
    await sendPublicFile(res, pathname);
    return;
  }

  throw jsonError('Not found.', 404, 'NOT_FOUND');
}

const server = createServer(async (req, res) => {
  try {
    checkRateLimit(req);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (
      (await handleTasks(req, res, url)) ||
      (await handleFocus(req, res, url)) ||
      (await handleAudio(req, res, url))
    ) {
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      throw jsonError('Route not found.', 404, 'NOT_FOUND');
    }
    await serveStatic(req, res, url);
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
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
    console.log('Emotional Damage running behind Passenger');
    return;
  }

  const maxPort = portIsFixed ? preferredPort : preferredPort + 99;

  for (let candidate = preferredPort; candidate <= maxPort; candidate += 1) {
    try {
      port = await tryListen(candidate);
      if (candidate !== preferredPort) {
        console.warn(`Port ${preferredPort} was in use; using ${port} instead.`);
      }
      console.log(`Emotional Damage running at http://${host}:${port}`);
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
