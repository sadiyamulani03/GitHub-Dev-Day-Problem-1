'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestContext } = require('./helpers/test-app');
const authService = require('../src/services/auth.service');
const sessionsRepo = require('../src/db/repositories/sessions.repo');
const { hashSessionToken } = require('../src/services/password.service');
const { nowIso } = require('../src/lib/time');

test('authentication', async (t) => {
  const context = await createTestContext();
  t.after(() => context.close());

  await t.test('registration creates an account and starts a session', async () => {
    const client = context.createClient();
    const response = await client.register({ email: 'Priya@Example.com', displayName: 'Priya' });

    assert.equal(response.status, 201);
    assert.equal(response.body.user.email, 'priya@example.com', 'emails are normalised');
    assert.equal(response.body.user.displayName, 'Priya');
    // No password material is ever echoed back.
    assert.equal(JSON.stringify(response.body).includes('password'), false);

    const cookie = response.headers.getSetCookie()[0];
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);

    const me = await client.get('/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'priya@example.com');
  });

  await t.test('the password is stored as a salted scrypt digest, never in clear', async () => {
    const client = context.createClient();
    await client.register({ email: 'hash@example.com', password: 'plaintext-password' });

    const row = context.db
      .prepare('SELECT password_hash FROM users WHERE email = ?')
      .get('hash@example.com');

    assert.ok(row.password_hash.startsWith('scrypt$'));
    assert.equal(row.password_hash.includes('plaintext-password'), false);
  });

  await t.test('the raw session token is never stored in the database', async () => {
    const client = context.createClient();
    await client.register({ email: 'token@example.com' });
    const rawToken = client.jar.cookies.get('pdo_session');

    const stored = context.db.prepare('SELECT token_hash FROM sessions').all();
    assert.ok(stored.length >= 1);
    assert.equal(
      stored.some((row) => row.token_hash === rawToken),
      false,
      'only the digest is persisted',
    );
    assert.ok(
      stored.some((row) => row.token_hash === hashSessionToken(rawToken)),
      'the digest of the issued token is present',
    );
  });

  await t.test('duplicate emails are rejected with 409', async () => {
    const first = context.createClient();
    const second = context.createClient();

    await first.register({ email: 'dup@example.com' });
    const response = await second.register({ email: 'dup@example.com' });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'EMAIL_IN_USE');
  });

  await t.test('weak or malformed registration input is rejected server-side', async () => {
    const client = context.createClient();

    const short = await client.register({ email: 'weak@example.com', password: 'short' });
    assert.equal(short.status, 400);

    const malformed = await client.register({ email: 'not-an-email', password: 'longenough' });
    assert.equal(malformed.status, 400);

    const missing = await client.request('POST', '/auth/register', { body: {} });
    assert.equal(missing.status, 400);
  });

  await t.test('login with the right password succeeds', async () => {
    const setup = context.createClient();
    await setup.register({ email: 'login@example.com', password: 'correct-horse-1' });
    await setup.post('/auth/logout');

    const client = context.createClient();
    const response = await client.post('/auth/login', {
      email: 'login@example.com',
      password: 'correct-horse-1',
    });

    assert.equal(response.status, 200);
    assert.equal((await client.get('/me')).status, 200);
  });

  await t.test('login failures are generic and never reveal whether an account exists', async () => {
    const setup = context.createClient();
    await setup.register({ email: 'real@example.com', password: 'correct-horse-1' });

    const wrongPassword = context.createClient();
    const wrong = await wrongPassword.post('/auth/login', {
      email: 'real@example.com',
      password: 'wrong-password-1',
    });

    const unknownAccount = context.createClient();
    const unknown = await unknownAccount.post('/auth/login', {
      email: 'ghost@example.com',
      password: 'wrong-password-1',
    });

    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error.message, unknown.body.error.message);
    assert.equal(wrong.body.error.code, 'UNAUTHENTICATED');
  });

  await t.test('logout destroys the session server-side, not just the cookie', async () => {
    const client = context.createClient();
    await client.register({ email: 'bye@example.com' });

    const stolenToken = client.jar.cookies.get('pdo_session');
    assert.equal((await client.post('/auth/logout')).status, 204);
    assert.equal((await client.get('/me')).status, 401, 'the cookie is gone');

    // Even replaying the old token by hand fails: the row is deleted.
    const replay = context.createClient();
    replay.jar.cookies.set('pdo_session', stolenToken);
    assert.equal((await replay.get('/me')).status, 401);
  });

  await t.test('a forged or expired session token is rejected', async () => {
    const forged = context.createClient();
    forged.jar.cookies.set('pdo_session', 'not-a-real-token-but-long-enough-to-pass-shape-checks');
    assert.equal((await forged.get('/me')).status, 401);

    const setup = context.createClient();
    await setup.register({ email: 'expired@example.com' });
    const token = setup.jar.cookies.get('pdo_session');

    // Expire the session directly in the database.
    context.db
      .prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
      .run('2000-01-01T00:00:00.000Z', hashSessionToken(token));

    assert.equal(await authService.resolveSession(context.db, token), null);
    assert.equal((await setup.get('/me')).status, 401, 'an expired session cannot authenticate');
  });

  await t.test('unauthenticated access to every protected route is 401', async () => {
    const anonymous = context.createClient();
    const routes = [
      ['GET', '/me'],
      ['GET', '/auth/me'],
      ['GET', '/teams'],
      ['POST', '/teams'],
      ['GET', '/teams/1'],
      ['PATCH', '/teams/1'],
      ['PUT', '/teams/1'],
      ['DELETE', '/teams/1'],
      ['POST', '/teams/1/recommendation'],
      ['GET', '/teams/1/recommendation'],
      ['GET', '/teams/1/recommendations'],
    ];

    for (const [method, path] of routes) {
      const response = await anonymous.request(method, path, method === 'GET' ? {} : { body: {} });
      assert.equal(response.status, 401, `${method} ${path} should require a session`);
      assert.equal(response.body.error.code, 'UNAUTHENTICATED');
    }
  });

  await t.test('expired sessions are purged by housekeeping', async () => {
    const client = context.createClient();
    await client.register({ email: 'purge@example.com' });

    context.db
      .prepare(
        'UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)',
      )
      .run('2000-01-01T00:00:00.000Z', 'purge@example.com');

    assert.ok(authService.purgeExpiredSessions(context.db) >= 1);
    assert.equal(sessionsRepo.findSessionWithUser(context.db, 'no-such-token', nowIso()), null);
  });
});
