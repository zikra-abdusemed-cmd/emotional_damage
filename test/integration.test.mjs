import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.NODE_TEST = '1';

let server;
let tempRoot;
let port;

async function request(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json, contentType: response.headers.get('content-type') || '' };
}

test('integration suite', async (t) => {
  tempRoot = await mkdtemp(join(tmpdir(), 'ed-integration-'));
  const dbFile = join(tempRoot, 'db.json');
  const audioDir = join(tempRoot, 'audio');
  await mkdir(audioDir, { recursive: true });
  await writeFile(join(audioDir, 'reminder.mp3'), 'fake-audio');
  await writeFile(dbFile, JSON.stringify({ tasks: [], focusSessions: [] }));

  process.env.DB_FILE = dbFile;
  process.env.AUDIO_DIR = audioDir;

  const mod = await import('../src/server.mjs');
  server = mod.server;
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;

  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(tempRoot, { recursive: true, force: true });
  });

  await t.test('static routes serve landing, app, css, and js', async () => {
    const landing = await request('GET', '/');
    assert.equal(landing.status, 200);
    assert.match(landing.text, /Focus on/);
    assert.match(landing.text, /Enter app/);
    assert.doesNotMatch(landing.text, /id="taskForm"/);

    const app = await request('GET', '/app');
    assert.equal(app.status, 200);
    assert.match(app.text, /id="taskForm"/);
    assert.match(app.text, /id="startFocus"/);

    const appSlash = await request('GET', '/app/');
    assert.equal(appSlash.status, 200);
    assert.match(appSlash.text, /id="taskForm"/);

    const css = await request('GET', '/css/theme.css');
    assert.equal(css.status, 200);
    assert.match(css.contentType, /text\/css/);

    const js = await request('GET', '/js/app.js');
    assert.equal(js.status, 200);
    assert.match(js.contentType, /javascript/);
    assert.match(js.text, /async function addTask/);
    assert.match(js.text, /async function triggerReminder/);

    const missing = await request('GET', '/missing-page');
    assert.equal(missing.status, 404);
  });

  await t.test('task and focus flows work end to end', async () => {
    const created = await request('POST', '/api/tasks', { title: 'Write tests' });
    assert.equal(created.status, 201);
    assert.equal(created.json.task.title, 'Write tests');

    const taskId = created.json.task.id;

    const renamed = await request('PATCH', `/api/tasks/${taskId}`, { title: 'Write more tests' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.task.title, 'Write more tests');

    const started = await request('POST', '/api/focus/start', {});
    assert.equal(started.status, 200);
    assert.equal(started.json.session.status, 'FOCUSING');

    const paused = await request('POST', '/api/focus/pause', {});
    assert.equal(paused.status, 200);
    assert.equal(paused.json.session.status, 'PAUSED');

    const resumed = await request('POST', '/api/focus/resume', {});
    assert.equal(resumed.status, 200);
    assert.equal(resumed.json.session.status, 'FOCUSING');

    const ended = await request('POST', '/api/focus/end', {});
    assert.equal(ended.status, 200);
    assert.equal(ended.json.session, null);

    const completed = await request('PATCH', `/api/tasks/${taskId}`, { completed: true });
    assert.equal(completed.status, 200);
    assert.equal(completed.json.task.completed, true);
  });

  await t.test('audio list and stream endpoints work', async () => {
    const list = await request('GET', '/api/audio');
    assert.equal(list.status, 200);
    assert.equal(list.json.count, 1);

    const streamUrl = list.json.audio[0].streamUrl;
    const stream = await request('GET', streamUrl);
    assert.equal(stream.status, 200);
    assert.match(stream.contentType, /audio/);
  });
});
