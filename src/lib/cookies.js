'use strict';

/**
 * Tiny cookie parsing helper.
 *
 * Express can *set* cookies (`res.cookie`) but not read them, and `cookie-parser`
 * would be an extra dependency for five lines of work: this project keeps its
 * dependency surface deliberately small (no unnecessary packages).
 *
 * Only the session cookie is ever read, and its value is opaque base64url.
 */
function parseCookieHeader(header) {
  const cookies = {};
  if (typeof header !== 'string' || header === '') {
    return cookies;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name === '') {
      continue;
    }
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }

  return cookies;
}

/** Middleware: attach a parsed `req.cookies` object. */
function cookieParser() {
  return function attachCookies(req, _res, next) {
    req.cookies = parseCookieHeader(req.headers.cookie);
    next();
  };
}

module.exports = { parseCookieHeader, cookieParser };
