import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstashDatabase } from '../src/db.mjs';

function fakeUpstash(initial = null) {
  const store = new Map();
  if (initial !== null) store.set('do-the-damn-thing:db', initial);
  const calls = [];
  const fetchImpl = async (url, options) => {
    const args = JSON.parse(options.body);
    calls.push({ url, auth: options.headers.authorization, args });
    let result = null;
    if (args[0] === 'GET') result = store.has(args[1]) ? store.get(args[1]) : null;
    if (args[0] === 'SET') {
      store.set(args[1], args[2]);
      result = 'OK';
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return { store, calls, fetchImpl };
}

test('empty store reads as initial data', async () => {
  const fake = fakeUpstash();
  const db = new UpstashDatabase({ url: 'https://example.upstash.io/', token: 'secret', fetchImpl: fake.fetchImpl });
  const data = await db.read();
  assert.deepEqual(data.tasks, []);
  assert.deepEqual(data.focusSessions, []);
  assert.equal(fake.calls[0].url, 'https://example.upstash.io');
  assert.equal(fake.calls[0].auth, 'Bearer secret');
});

test('updates stay in memory and are saved in one batch on flush', async () => {
  const fake = fakeUpstash(JSON.stringify({ tasks: [{ id: 'a' }], focusSessions: [] }));
  const db = new UpstashDatabase({ url: 'https://x', token: 't', fetchImpl: fake.fetchImpl, flushDelayMs: 60_000 });
  await db.update((data) => { data.tasks.push({ id: 'b' }); });
  await db.update((data) => { data.tasks.push({ id: 'c' }); });
  assert.deepEqual((await db.read()).tasks.map((task) => task.id), ['a', 'b', 'c']);
  assert.equal(fake.calls.filter((call) => call.args[0] === 'GET').length, 1);
  assert.equal(fake.calls.filter((call) => call.args[0] === 'SET').length, 0);

  await db.flush();
  await db.flush();
  const sets = fake.calls.filter((call) => call.args[0] === 'SET');
  assert.equal(sets.length, 1);
  assert.deepEqual(JSON.parse(fake.store.get('do-the-damn-thing:db')).tasks.map((task) => task.id), ['a', 'b', 'c']);
});

test('a failed mutation does not change stored data', async () => {
  const fake = fakeUpstash();
  const db = new UpstashDatabase({ url: 'https://x', token: 't', fetchImpl: fake.fetchImpl, flushDelayMs: 60_000 });
  await assert.rejects(db.update((data) => {
    data.tasks.push({ id: 'oops' });
    throw new Error('boom');
  }));
  assert.deepEqual((await db.read()).tasks, []);
});

test('a failed save is retried on the next flush', async () => {
  const fake = fakeUpstash();
  let fail = true;
  const fetchImpl = async (url, options) => {
    if (fail && JSON.parse(options.body)[0] === 'SET') {
      return { ok: false, status: 500, json: async () => ({ error: 'down' }) };
    }
    return fake.fetchImpl(url, options);
  };
  const db = new UpstashDatabase({ url: 'https://x', token: 't', fetchImpl, flushDelayMs: 60_000 });
  await db.update((data) => { data.tasks.push({ id: 'keep' }); });
  await assert.rejects(db.flush(), /Upstash SET failed: down/);
  fail = false;
  await db.flush();
  assert.equal(JSON.parse(fake.store.get('do-the-damn-thing:db')).tasks[0].id, 'keep');
});
