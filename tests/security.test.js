'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestContext, teamPayload } = require('./helpers/test-app');
const { scanRepository, formatFindings } = require('../scripts/secret-scan');

/**
 * PHASE 9: attacking our own application over HTTP.
 *
 * Every case asserts a *correct* 4xx (or another safe, non-leaking response)
 * rather than a 500, and that the database is untouched afterwards.
 */
test('adversarial security testing', async (t) => {
  const context = await createTestContext();
  t.after(() => context.close());

  const coach = context.createClient();
  await coach.register({ email: 'victim@example.com' });
  const team = (await coach.post('/teams', teamPayload({ name: 'Victim FC' }))).body.team;

  await t.test('SQL injection strings never reach a query and never break the app', async () => {
    const payloads = [
      "1' OR '1'='1",
      '1; DROP TABLE teams; --',
      '1 UNION SELECT password_hash FROM users',
      '1 OR 1=1',
      "'; DELETE FROM recommendations; --",
      '1/**/OR/**/1=1',
    ];

    for (const payload of payloads) {
      const byPath = await coach.get(`/teams/${encodeURIComponent(payload)}`);
      assert.equal(byPath.status, 400, `id "${payload}" must be rejected as malformed`);
      assert.equal(byPath.body.error.code, 'VALIDATION_ERROR');
    }

    // Injection attempts in place names are rejected by the location allow-list.
    const locationInjection = await coach.post(
      '/teams',
      teamPayload({ location: "x'; DROP TABLE teams; --" }),
    );
    assert.equal(locationInjection.status, 400);

    // A legitimate apostrophe still works: the rule is about SQL-safe input,
    // not about banning punctuation people actually use.
    const simpleApostrophe = await coach.post('/teams', teamPayload({ name: "St. Mary's FC" }));
    assert.equal(simpleApostrophe.status, 201);
    assert.equal(simpleApostrophe.body.team.name, "St. Mary's FC");

    // Every table is still present and every row still there.
    assert.equal(context.db.prepare('SELECT COUNT(*) AS total FROM users').get().total, 1);
    assert.ok(context.db.prepare('SELECT COUNT(*) AS total FROM teams').get().total >= 2);
    assert.ok(
      context.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length >= 4,
    );
    assert.ok(team.id > 0);
  });

  await t.test('malformed JSON and wrong bodies get a clean 400, never a 500', async () => {
    const truncated = await coach.request('POST', '/teams', { raw: '{"name": ' });
    assert.equal(truncated.status, 400);
    assert.equal(truncated.body.error.code, 'INVALID_JSON');

    const arrayBody = await coach.request('POST', '/teams', { raw: '["not","an","object"]' });
    assert.equal(arrayBody.status, 400);

    const emptyBody = await coach.request('POST', '/teams', { raw: '' });
    assert.equal(emptyBody.status, 400);

    const wrongType = await coach.request('POST', '/teams', {
      raw: '{"name": 12345, "location": "Austin"}',
    });
    assert.equal(wrongType.status, 400);
  });

  await t.test('an oversized body is rejected instead of being buffered', async () => {
    const huge = await coach.request('POST', '/teams', {
      raw: JSON.stringify({ name: 'Big', location: 'Austin', padding: 'x'.repeat(40 * 1024) }),
    });
    assert.equal(huge.status, 413);
    assert.equal(huge.body.error.code, 'PAYLOAD_TOO_LARGE');

    const hugeAuth = await coach.request('POST', '/auth/register', {
      raw: JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(40 * 1024) }),
    });
    assert.equal(hugeAuth.status, 413);
  });

  await t.test('every error response is JSON, has a code, and leaks nothing', async () => {
    const responses = await Promise.all([
      coach.get('/teams/abc'),
      coach.get('/teams/999999'),
      coach.post('/teams', {}),
      coach.post('/teams/1/recommendation', { temperature: 30 }),
      coach.get('/no-such-route'),
      coach.request('POST', '/teams', { raw: '{broken' }),
    ]);

    for (const response of responses) {
      assert.ok(response.status >= 400, `expected an error status, got ${response.status}`);
      assert.ok(response.body.error, 'the body follows the error envelope');
      assert.equal(typeof response.body.error.code, 'string');
      assert.equal(typeof response.body.error.message, 'string');

      const serialised = JSON.stringify(response.body);
      // No stack traces, no SQL, no internal file paths.
      assert.equal(/at\s+\w+\s+\(.+:\d+:\d+\)/.test(serialised), false, 'no stack trace');
      assert.equal(/SELECT|INSERT INTO|DELETE FROM|SQLITE_/i.test(serialised), false, 'no SQL');
      assert.equal(/node_modules|\.js:\d+/.test(serialised), false, 'no internal paths');
    }
  });

  await t.test('unknown routes and wrong methods are 404 with a JSON body', async () => {
    const unknown = await coach.get('/definitely/not/a/route');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'NOT_FOUND');

    const wrongMethod = await coach.request('POST', '/me', { body: {} });
    assert.equal(wrongMethod.status, 404);
  });

  await t.test('baseline security headers are present and the stack is not advertised', async () => {
    const health = await coach.get('/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-powered-by'), null);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
    assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
  });

  // APPEND_MARKER
});
