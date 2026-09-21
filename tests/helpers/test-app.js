'use strict';

const { createApp } = require('../../src/app');
const { openDatabase } = require('../../src/db');
const { loadConfig } = require('../../src/config');
const authService = require('../../src/services/auth.service');
const { createFakeWeatherService, createFakeGeocodingService } = require('./fake-weather');

/**
 * Boots the real application on an ephemeral port with an in-memory database and
 * fake upstream providers. Tests then drive it over real HTTP with a cookie jar,
 * so routing, middleware, JSON parsing, status codes and the session cookie are
 * all genuinely exercised.
 */

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(response) {
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);

    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '' || /expires=thu, 01 jan 1970/i.test(raw)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header() {
    if (this.cookies.size === 0) {
      return undefined;
    }
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

async function createTestContext({
  weather = {},
  geocoder = {},
  configOverrides = {},
  weatherService: injectedWeatherService,
} = {}) {
  const config = loadConfig({
    env: 'test',
    isProduction: false,
    databasePath: ':memory:',
    port: 0,
    sessionTtlHours: 1,
    practiceDurationMinutes: 90,
    ...configOverrides,
  });

  const db = openDatabase(':memory:');
  const weatherService = injectedWeatherService || createFakeWeatherService(weather);
  const geocodingService = createFakeGeocodingService(geocoder);

  const app = createApp({ db, config, weatherService, geocodingService, authService });

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  /** Create an independent client (its own cookie jar = its own logged-in coach). */
  function createClient() {
    const jar = new CookieJar();

    async function request(method, path, { body, headers = {}, raw } = {}) {
      const options = {
        method,
        headers: { ...headers },
        redirect: 'manual',
      };

      const cookieHeader = jar.header();
      if (cookieHeader) {
        options.headers.cookie = cookieHeader;
      }

      if (raw !== undefined) {
        options.body = raw;
        options.headers['content-type'] = 'application/json';
      } else if (body !== undefined) {
        options.body = JSON.stringify(body);
        options.headers['content-type'] = 'application/json';
      }

      const response = await fetch(`${baseUrl}${path}`, options);
      jar.store(response);

      const text = await response.text();
      let parsed = null;
      if (text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }

      return { status: response.status, body: parsed, headers: response.headers };
    }

    return {
      jar,
      request,
      get: (path, options) => request('GET', path, options),
      post: (path, body, options) => request('POST', path, { body, ...options }),
      patch: (path, body, options) => request('PATCH', path, { body, ...options }),
      put: (path, body, options) => request('PUT', path, { body, ...options }),
      del: (path, options) => request('DELETE', path, options),

      async register({ email, password = 'sup3r-secret-pass', displayName = 'Coach' }) {
        return request('POST', '/auth/register', { body: { email, password, displayName } });
      },
    };
  }

  return {
    app,
    db,
    config,
    weatherService,
    geocodingService,
    baseUrl,
    createClient,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

/** A valid team payload using a place name that the fake geocoder knows. */
function teamPayload(overrides = {}) {
  return {
    name: 'U10 Thunder',
    location: 'Austin',
    practiceDays: [1, 3],
    practiceTime: '17:30',
    ...overrides,
  };
}

module.exports = { createTestContext, teamPayload, CookieJar };
