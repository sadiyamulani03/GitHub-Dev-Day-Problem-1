'use strict';

const { unauthenticated } = require('../lib/errors');

/**
 * Authentication middleware (PHASE 5).
 *
 * The identity of a request comes ONLY from the server-side session store:
 *
 *   cookie token -> SHA-256 digest -> `sessions` JOIN `users` -> req.user
 *
 * There is no client-supplied user id anywhere in the authorisation path, and
 * no signed payload for a client to forge: the token is 256 bits of CSPRNG
 * output and the server owns the mapping. `attachSession` never rejects a
 * request -- it only annotates it -- so routes decide their own requirements,
 * while `requireAuth` is the explicit gate for protected routes.
 */
function createAuthMiddleware({ db, config, authService }) {
  const cookieOptions = {
    httpOnly: true, // not readable from JavaScript: no XSS token theft
    sameSite: 'lax', // blocks cross-site form/CSRF-style writes
    secure: config.isProduction, // HTTPS-only cookie in production
    path: '/',
    maxAge: config.sessionTtlHours * 3600 * 1000,
  };

  function attachSession(req, _res, next) {
    const token = req.cookies ? req.cookies[config.sessionCookieName] : undefined;
    req.sessionToken = typeof token === 'string' && token !== '' ? token : null;
    req.user = null;

    if (req.sessionToken) {
      try {
        const session = authService.resolveSession(db, req.sessionToken);
        if (session) {
          req.user = session.user;
          req.sessionExpiresAt = session.expiresAt;
        }
      } catch (error) {
        return next(error);
      }
    }

    return next();
  }

  /** Gate for every authenticated route. */
  function requireAuth(req, _res, next) {
    if (!req.user) {
      return next(unauthenticated());
    }
    return next();
  }

  function setSessionCookie(res, token) {
    res.cookie(config.sessionCookieName, token, cookieOptions);
  }

  function clearSessionCookie(res) {
    res.clearCookie(config.sessionCookieName, { ...cookieOptions, maxAge: undefined });
  }

  return { attachSession, requireAuth, setSessionCookie, clearSessionCookie, cookieOptions };
}

module.exports = { createAuthMiddleware };
