import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertJsonContentType,
  assertSameOrigin,
  isHttps,
  needsLegacyAdoption,
  parseCookies,
  profileCookie,
  pruneStore,
  securityHeaders
} from '../src/security.mjs';

test('profile cookies are HttpOnly and SameSite=Lax', () => {
  const cookie = profileCookie('profile_11111111-1111-4111-8111-111111111111', { headers: {} });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/);
});

test('https and TRUST_PROXY enable Secure cookies and HSTS', () => {
  const previousTrust = process.env.TRUST_PROXY;
  const previousSecure = process.env.SECURE_COOKIES;
  process.env.TRUST_PROXY = '1';
  delete process.env.SECURE_COOKIES;
  try {
    const req = { headers: { 'x-forwarded-proto': 'https' } };
    assert.equal(isHttps(req), true);
    assert.match(profileCookie('profile_11111111-1111-4111-8111-111111111111', req), /Secure/);
    assert.match(securityHeaders(req)['strict-transport-security'], /max-age/);
  } finally {
    if (previousTrust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrust;
    if (previousSecure === undefined) delete process.env.SECURE_COOKIES;
    else process.env.SECURE_COOKIES = previousSecure;
  }
});

test('x-forwarded-proto is ignored without TRUST_PROXY', () => {
  delete process.env.TRUST_PROXY;
  assert.equal(isHttps({ headers: { 'x-forwarded-proto': 'https' } }), false);
});

test('same-origin writes are allowed and cross-origin writes are blocked', () => {
  const req = {
    method: 'POST',
    headers: { origin: 'https://app.example', host: 'app.example' }
  };
  assert.doesNotThrow(() => assertSameOrigin(req));
  req.headers.origin = 'https://evil.example';
  assert.throws(() => assertSameOrigin(req), /Forbidden/);
});

test('mutating requests require JSON content type', () => {
  assert.doesNotThrow(() => assertJsonContentType({
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' }
  }));
  assert.throws(() => assertJsonContentType({
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'content-length': '4' }
  }), /Unsupported/);
});

test('cookie parser decodes values', () => {
  const cookies = parseCookies('ed_profile=profile_11111111-1111-4111-8111-111111111111; other=a%3Db');
  assert.equal(cookies.get('other'), 'a=b');
});

test('legacy adoption only happens for the original local user', () => {
  const empty = { tasks: [], focusSessions: [] };
  assert.equal(needsLegacyAdoption(empty, 'profile_a'), false);
  const local = { tasks: [{ userId: 'local-user' }], focusSessions: [] };
  assert.equal(needsLegacyAdoption(local, 'profile_a'), true);
  const other = { tasks: [{ userId: 'profile_b' }], focusSessions: [] };
  assert.equal(needsLegacyAdoption(other, 'profile_a'), false);
});

test('completed tasks are kept when pruning', () => {
  const data = {
    tasks: [
      { userId: 'p', completed: false, completedAt: null },
      { userId: 'p', completed: true, completedAt: '2026-01-02T00:00:00.000Z' },
      { userId: 'p', completed: true, completedAt: '2026-01-01T00:00:00.000Z' }
    ],
    focusSessions: []
  };
  pruneStore(data, { maxCompleted: 1 });
  assert.equal(data.tasks.filter((task) => task.completed).length, 1);
  assert.equal(data.tasks.filter((task) => !task.completed).length, 1);
  assert.equal(data.tasks.find((task) => task.completed).completedAt, '2026-01-02T00:00:00.000Z');
});
