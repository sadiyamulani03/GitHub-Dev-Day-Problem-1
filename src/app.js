'use strict';

const path = require('node:path');
const express = require('express');

const { cookieParser } = require('./lib/cookies');
const { securityHeaders } = require('./middleware/security');
const { createAuthMiddleware } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { createAuthRouter } = require('./routes/auth.routes');
const { createTeamsRouter } = require('./routes/teams.routes');

/**
 * Express application factory.
 *
 * Everything the app needs is injected (`db`, `config`, provider services), so
 * the whole HTTP surface can be booted in a test with an in-memory database and
 * a fake weather provider -- no network, no ports, no shared state between
 * tests. `src/server.js` is the only place that binds a real port.
 */
function createApp({ db, config, weatherService, geocodingService, authService }) {
  const app = express();

  app.disable('x-powered-by');
  // Only trust X-Forwarded-* when the deployment says it is behind a proxy.
  app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders({ isProduction: config.isProduction }));

  // Strict, small JSON bodies: the API never needs to accept a large upload.
  app.use(express.json({ limit: '20kb', strict: true }));

  app.use(cookieParser());

  const auth = createAuthMiddleware({ db, config, authService });
  app.use(auth.attachSession);

  // Static, dependency-free UI. It renders data from the API above; it never
  // decides anything (see src/public/app.js).
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use(
    createAuthRouter({
      db,
      authService,
      auth,
      sessionTtlHours: config.sessionTtlHours,
    }),
  );

  app.use(
    createTeamsRouter({
      db,
      config,
      auth,
      weatherService,
      geocodingService,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
