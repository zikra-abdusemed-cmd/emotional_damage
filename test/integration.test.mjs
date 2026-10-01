import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.NODE_TEST = '1';

let server;
let tempRoot;
let port;

function cookieFrom(setCookie) {
  return String(setCookie || '').split(';')[0];
}

async function request(method, path, { body, jar } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (jar?.cookie) headers.cookie = jar.cookie;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = response.headers.get('set-cookie') || '';
  if (jar && setCookie) jar.cookie = cookieFrom(setCookie);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    text,
    json,
    contentType: response.headers.get('content-type') || '',
    csp: response.headers.get('content-security-policy') || '',
    frame: response.headers.get('x-frame-options') || '',
    setCookie
  };
}

test('integration suite', async (t) => {
  tempRoot = await mkdtemp(join(tmpdir(), 'ed-integration-'));
  const dbFile = join(tempRoot, 'db.json');
  const audioDir = join(tempRoot, 'audio');
  await mkdir(audioDir, { recursive: true });
  await writeFile(join(audioDir, 'reminder.mp3'), 'fake-audio');
  await writeFile(join(audioDir, 'second.wav'), 'fake-wav');
  await writeFile(dbFile, JSON.stringify({ tasks: [], focusSessions: [] }));

  process.env.DB_FILE = dbFile;
  process.env.AUDIO_DIR = audioDir;

  const mod = await import('../src/server.mjs');
  server = mod.server;
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
  const jar = { cookie: '' };

  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(tempRoot, { recursive: true, force: true });
  });

  await t.test('static routes serve landing, app, css, and js', async () => {
    const landing = await request('GET', '/', { jar });
    assert.equal(landing.status, 200);
    assert.match(landing.text, /Focus on/);
    assert.match(landing.text, /Enter app/);
    assert.match(landing.csp, /default-src 'self'/);
    assert.equal(landing.frame, 'DENY');
    assert.match(landing.setCookie, /ed_profile=profile_/);
    assert.match(landing.text, /id="statVisitors"/);
    assert.match(landing.text, /Total Site Visits/);
    assert.match(landing.text, /Currently Active Users/);
    assert.match(landing.text, /Total Tasks Crossed Off/);
    assert.doesNotMatch(landing.text, /Right now/i);
    assert.doesNotMatch(landing.text, /class="diagonal/);
    assert.match(landing.text, /\/js\/landing\.js/);
    assert.doesNotMatch(landing.text, /id="taskForm"/);

    const app = await request('GET', '/app', { jar });
    assert.equal(app.status, 200);
    assert.match(app.text, /id="taskForm"/);
    assert.match(app.text, /id="startFocus"/);

    const appSlash = await request('GET', '/app/', { jar });
    assert.equal(appSlash.status, 200);
    assert.match(appSlash.text, /id="taskForm"/);

    const css = await request('GET', '/css/theme.css', { jar });
    assert.equal(css.status, 200);
    assert.match(css.contentType, /text\/css/);

    const landingJs = await request('GET', '/js/landing.js', { jar });
    assert.equal(landingJs.status, 200);
    assert.match(landingJs.contentType, /javascript/);
    assert.match(landingJs.text, /\/api\/stats/);

    const js = await request('GET', '/js/app.js', { jar });
    assert.equal(js.status, 200);
    assert.match(js.contentType, /javascript/);
    assert.match(js.text, /async function addTask/);
    assert.match(js.text, /async function triggerReminder/);
    assert.match(js.text, /focusNotificationCopy/);

    const missing = await request('GET', '/missing-page', { jar });
    assert.equal(missing.status, 404);

    const traversal = await request('GET', '/css/../src/server.mjs', { jar });
    assert.equal(traversal.status, 404);
  });

  await t.test('task and focus flows persist completed work', async () => {
    const noTasks = await request('POST', '/api/focus/start', { jar, body: {} });
    assert.equal(noTasks.status, 409);

    const created = await request('POST', '/api/tasks', { jar, body: { title: 'Write tests' } });
    assert.equal(created.status, 201);
    assert.equal(created.json.task.title, 'Write tests');

    const taskId = created.json.task.id;

    const renamed = await request('PATCH', `/api/tasks/${taskId}`, { jar, body: { title: 'Write more tests' } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.task.title, 'Write more tests');

    const started = await request('POST', '/api/focus/start', { jar, body: {} });
    assert.equal(started.status, 200);
    assert.equal(started.json.session.status, 'FOCUSING');

    const paused = await request('POST', '/api/focus/pause', { jar, body: {} });
    assert.equal(paused.status, 200);
    assert.equal(paused.json.session.status, 'PAUSED');

    const resumed = await request('POST', '/api/focus/resume', { jar, body: {} });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.json.session.status, 'FOCUSING');

    const ended = await request('POST', '/api/focus/end', { jar, body: {} });
    assert.equal(ended.status, 200);
    assert.equal(ended.json.session, null);

    const completed = await request('PATCH', `/api/tasks/${taskId}`, { jar, body: { completed: true } });
    assert.equal(completed.status, 200);
    assert.equal(completed.json.task.completed, true);

    const listed = await request('GET', '/api/tasks', { jar });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.tasks.find((task) => task.id === taskId)?.completed, true);

    const current = await request('GET', '/api/focus/current', { jar });
    assert.equal(current.json.tasks.find((task) => task.id === taskId)?.completed, true);
    assert.match(current.setCookie, /ed_profile=/);

    const reopened = { cookie: jar.cookie };
    const restored = await request('GET', '/api/focus/current', { jar: reopened });
    assert.equal(restored.json.tasks.find((task) => task.id === taskId)?.completed, true);
  });

  await t.test('browser profiles keep separate sessions', async () => {
    const chrome = { cookie: '' };
    const safari = { cookie: '' };
    const first = await request('POST', '/api/tasks', { jar: chrome, body: { title: 'Chrome only' } });
    const second = await request('POST', '/api/tasks', { jar: safari, body: { title: 'Safari only' } });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(chrome.cookie, safari.cookie);

    const chromeTasks = await request('GET', '/api/tasks', { jar: chrome });
    const safariTasks = await request('GET', '/api/tasks', { jar: safari });
    assert.equal(chromeTasks.json.tasks.some((task) => task.title === 'Chrome only'), true);
    assert.equal(chromeTasks.json.tasks.some((task) => task.title === 'Safari only'), false);
    assert.equal(safariTasks.json.tasks.some((task) => task.title === 'Safari only'), true);
    assert.equal(safariTasks.json.tasks.some((task) => task.title === 'Chrome only'), false);
  });

  await t.test('audio list includes every folder clip and rejects bad ids', async () => {
    const list = await request('GET', '/api/audio', { jar });
    assert.equal(list.status, 200);
    assert.equal(list.json.count, 2);
    const names = list.json.audio.map((item) => item.name).sort();
    assert.deepEqual(names, ['Reminder', 'Second']);

    const streamUrl = list.json.audio[0].streamUrl;
    const stream = await request('GET', streamUrl, { jar });
    assert.equal(stream.status, 200);
    assert.match(stream.contentType, /audio/);

    const partial = await fetch(`http://127.0.0.1:${port}${streamUrl}`, { headers: { range: 'bytes=0-3', cookie: jar.cookie } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('accept-ranges'), 'bytes');
    assert.equal(partial.headers.get('content-range'), 'bytes 0-3/10');
    assert.equal(await partial.text(), 'fake');

    const unsatisfiable = await fetch(`http://127.0.0.1:${port}${streamUrl}`, { headers: { range: 'bytes=50-', cookie: jar.cookie } });
    assert.equal(unsatisfiable.status, 416);
    await unsatisfiable.text();

    const bad = await request('GET', '/api/audio/not-valid/file', { jar });
    assert.equal(bad.status, 404);

    await writeFile(join(process.env.AUDIO_DIR, 'third.ogg'), 'fake-ogg');
    const refreshed = await request('GET', '/api/audio', { jar });
    assert.equal(refreshed.json.count, 3);
  });

  await t.test('health check responds without touching the database', async () => {
    const health = await request('GET', '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true });
  });

  await t.test('cross-origin writes are rejected', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        cookie: jar.cookie
      },
      body: JSON.stringify({ title: 'stolen' })
    });
    assert.equal(response.status, 403);
  });

  await t.test('invalid json and task ids are rejected', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: jar.cookie },
      body: '{not-json'
    });
    assert.equal(response.status, 400);
    const missing = await request('PATCH', '/api/tasks/not-a-task', { jar, body: { title: 'Nope' } });
    assert.equal(missing.status, 404);
  });

  await t.test('public stats stay aggregate and count unique visitors', async () => {
    const before = await request('GET', '/api/stats', { jar });
    assert.equal(before.status, 200);
    assert.equal(typeof before.json.visitors, 'number');
    assert.equal(typeof before.json.activeUsers, 'number');
    assert.equal(typeof before.json.crossedOff, 'number');
    assert.equal('lastSeen' in before.json, false);
    assert.ok(before.json.visitors >= 1);
    assert.ok(before.json.crossedOff >= 1);

    await request('GET', '/', { jar });
    const sameProfile = await request('GET', '/api/stats', { jar });
    assert.equal(sameProfile.json.visitors, before.json.visitors);

    const guest = { cookie: '' };
    await request('GET', '/', { jar: guest });
    const afterGuest = await request('GET', '/api/stats', { jar });
    assert.equal(afterGuest.json.visitors, before.json.visitors + 1);
    assert.ok(afterGuest.json.activeUsers >= 2);
  });
});
