'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

/**
 * Password hashing with scrypt from Node's own `crypto` module.
 *
 * Why not bcrypt/argon2? They need a native build step for no security gain
 * here; scrypt is memory-hard, built in, and uses a per-password random salt.
 * Stored format: "scrypt$N$r$p$<salt-b64>$<derived-key-b64>" so the cost
 * parameters travel with the hash and can be raised later without a migration.
 */

const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64 });
const SALT_BYTES = 16;

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

function parseStoredHash(stored) {
  if (typeof stored !== 'string') {
    return null;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }
  const [, n, r, p, salt, hash] = parts;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return null;
  }
  return {
    params,
    salt: Buffer.from(salt, 'base64'),
    expected: Buffer.from(hash, 'base64'),
  };
}

/** Constant-time verification of a password against a stored hash. */
async function verifyPassword(password, stored) {
  const parsed = parseStoredHash(stored);
  if (!parsed || parsed.expected.length === 0) {
    return false;
  }
  const derived = await scrypt(password, parsed.salt, parsed.expected.length, {
    N: parsed.params.N,
    r: parsed.params.r,
    p: parsed.params.p,
  });
  return crypto.timingSafeEqual(derived, parsed.expected);
}

/**
 * Burn the same amount of work as a real verification when the account does not
 * exist, so response timing does not reveal which emails are registered.
 */
async function fakeVerify(password) {
  await scrypt(String(password), crypto.randomBytes(SALT_BYTES), SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return false;
}

/** Opaque session token. Only its digest is persisted. */
function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  hashPassword,
  verifyPassword,
  fakeVerify,
  generateSessionToken,
  hashSessionToken,
  SCRYPT_PARAMS,
};
