'use strict';

const usersRepo = require('../db/repositories/users.repo');
const sessionsRepo = require('../db/repositories/sessions.repo');
const {
  hashPassword,
  verifyPassword,
  fakeVerify,
  generateSessionToken,
  hashSessionToken,
} = require('./password.service');
const { conflict, unauthenticated, ERROR_CODES } = require('../lib/errors');
const { nowIso, isoHoursFromNow } = require('../lib/time');

/**
 * Authentication service (PHASE 5).
 *
 * Model: opaque, server-side sessions.
 *   - `POST /auth/register` / `POST /auth/login` create a session row and return
 *     an HttpOnly cookie holding a 256-bit random token.
 *   - The server resolves the coach's identity by hashing that token and looking
 *     it up in `sessions` (joined to `users`). A user id sent by the client is
 *     NEVER used as identity, and there is no client-forgeable token payload.
 *
 * The user-facing error for a failed login is deliberately generic
 * ("Email or password is incorrect") so it cannot be used to enumerate accounts.
 */

async function registerCoach(db, { email, password, displayName }) {
  const existing = usersRepo.findByEmail(db, email);
  if (existing) {
    throw conflict(ERROR_CODES.EMAIL_IN_USE, 'An account with that email already exists.');
  }

  const passwordHash = await hashPassword(password);

  try {
    return usersRepo.insertUser(db, { email, displayName, passwordHash });
  } catch (error) {
    // The UNIQUE index on users.email is the real guard: two concurrent
    // registrations for the same address cannot both succeed.
    if (error && typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) {
      throw conflict(ERROR_CODES.EMAIL_IN_USE, 'An account with that email already exists.');
    }
    throw error;
  }
}

async function authenticateCoach(db, { email, password }) {
  const user = usersRepo.findByEmail(db, email);

  if (!user) {
    await fakeVerify(password);
    throw unauthenticated('Email or password is incorrect.');
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw unauthenticated('Email or password is incorrect.');
  }

  return user;
}

/** Create a session row and return the raw token to place in the cookie. */
function createSession(db, userId, ttlHours) {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const createdAt = nowIso();
  const expiresAt = isoHoursFromNow(ttlHours);

  sessionsRepo.insertSession(db, { userId, tokenHash, createdAt, expiresAt });

  return { token, expiresAt };
}

/** Resolve the authenticated coach for a request, or null when unauthenticated. */
function resolveSession(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 256) {
    return null;
  }
  return sessionsRepo.findSessionWithUser(db, hashSessionToken(token), nowIso());
}

function destroySession(db, token) {
  if (typeof token !== 'string' || token === '') {
    return 0;
  }
  return sessionsRepo.deleteByTokenHash(db, hashSessionToken(token));
}

function purgeExpiredSessions(db) {
  return sessionsRepo.deleteExpired(db, nowIso());
}

module.exports = {
  registerCoach,
  authenticateCoach,
  createSession,
  resolveSession,
  destroySession,
  purgeExpiredSessions,
};
