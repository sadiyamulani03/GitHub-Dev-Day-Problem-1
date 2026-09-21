'use strict';

const path = require('node:path');
const { loadEnvFile } = require('./lib/env');

loadEnvFile();

/** Read an integer from the environment, falling back to `fallback` when unset/invalid. */
function readInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function readString(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/**
 * All configuration comes from the environment (CHECK 8).
 * No credential, token, key or authenticated URL is ever hardcoded here: the
 * upstream providers below are public, keyless APIs.
 */
function loadConfig(overrides = {}) {
  const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';

  const config = {
    env,
    isProduction: env === 'production',
    port: readInt('PORT', 3000, { min: 0, max: 65535 }),
    databasePath: readString('DATABASE_PATH', path.resolve(process.cwd(), 'data', 'app.db')),
    sessionTtlHours: readInt('SESSION_TTL_HOURS', 168),
    practiceDurationMinutes: readInt('PRACTICE_DURATION_MINUTES', 90, { min: 15, max: 360 }),
    weatherBaseUrl: readString('WEATHER_BASE_URL', 'https://api.open-meteo.com/v1'),
    geocodingBaseUrl: readString('GEOCODING_BASE_URL', 'https://geocoding-api.open-meteo.com/v1'),
    upstreamTimeoutMs: readInt('UPSTREAM_TIMEOUT_MS', 8000, { min: 500, max: 60000 }),
    // Session cookie name / flags (see middleware/auth.js).
    sessionCookieName: 'pdo_session',
    trustProxy: readInt('TRUST_PROXY', 0, { min: 0, max: 1 }) === 1,
  };

  return { ...config, ...overrides };
}

module.exports = { loadConfig };
