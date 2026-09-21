'use strict';

const express = require('express');
const {
  validateEmail,
  validatePassword,
  validateDisplayName,
  requirePlainObject,
} = require('../lib/validate');

/**
 * Auth + identity routes.
 *
 *   POST /auth/register   create a coach account and start a session
 *   POST /auth/login      start a session for an existing coach
 *   POST /auth/logout     destroy the session server-side and clear the cookie
 *   GET  /me              the authenticated coach (identity comes from the session)
 */
function createAuthRouter({ db, authService, auth, sessionTtlHours }) {
  const router = express.Router();

  router.post('/auth/register', async (req, res, next) => {
    try {
      const body = requirePlainObject(req.body);
      const email = validateEmail(body.email);
      const password = validatePassword(body.password);
      const displayName = validateDisplayName(body.displayName, email.split('@')[0]);

      const user = await authService.registerCoach(db, { email, password, displayName });
      const { token } = authService.createSession(db, user.id, sessionTtlHours);
      auth.setSessionCookie(res, token);

      res.status(201).json({
        user: { id: user.id, email: user.email, displayName: user.displayName },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/login', async (req, res, next) => {
    try {
      const body = requirePlainObject(req.body);
      const email = validateEmail(body.email);
      const password = validatePassword(body.password);

      const user = await authService.authenticateCoach(db, { email, password });
      const { token } = authService.createSession(db, user.id, sessionTtlHours);
      auth.setSessionCookie(res, token);

      res.status(200).json({
        user: { id: user.id, email: user.email, displayName: user.displayName },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/logout', (req, res, next) => {
    try {
      if (req.sessionToken) {
        authService.destroySession(db, req.sessionToken);
      }
      auth.clearSessionCookie(res);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  const me = (req, res) => {
    res.status(200).json({
      user: { id: req.user.id, email: req.user.email, displayName: req.user.displayName },
    });
  };

  router.get('/me', auth.requireAuth, me);
  router.get('/auth/me', auth.requireAuth, me);

  return router;
}

module.exports = { createAuthRouter };
