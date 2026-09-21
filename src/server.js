'use strict';

const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const authService = require('./services/auth.service');
const { createOpenMeteoWeatherService } = require('./services/weather.service');
const { createOpenMeteoGeocodingService } = require('./services/geocoding.service');

/**
 * Process entry point: read configuration, open the database, build the real
 * providers and listen. Everything else lives in `src/app.js` so it stays
 * testable.
 */

function main() {
  const config = loadConfig();

  const db = openDatabase(config.databasePath);

  // Cheap housekeeping: drop sessions that can no longer authenticate anybody.
  const purged = authService.purgeExpiredSessions(db);

  const weatherService = createOpenMeteoWeatherService({
    baseUrl: config.weatherBaseUrl,
    timeoutMs: config.upstreamTimeoutMs,
  });

  const geocodingService = createOpenMeteoGeocodingService({
    baseUrl: config.geocodingBaseUrl,
    timeoutMs: config.upstreamTimeoutMs,
  });

  const app = createApp({ db, config, weatherService, geocodingService, authService });

  const server = app.listen(config.port, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    // eslint-disable-next-line no-console
    console.log(
      [
        'Practice-Day Outfit Caller',
        `  env:        ${config.env}`,
        `  listening:  http://localhost:${port}`,
        `  database:   ${config.databasePath}`,
        `  weather:    ${config.weatherBaseUrl} (Open-Meteo, keyless)`,
        `  sessions:   ${purged} expired session(s) purged on boot`,
      ].join('\n'),
    );
  });

  // Do not leave the process hanging on a client that never reads.
  server.headersTimeout = 30000;
  server.requestTimeout = 30000;

  const shutdown = (signal) => () => {
    // eslint-disable-next-line no-console
    console.log(`\nReceived ${signal}, shutting down.`);
    server.close(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  // Fail loudly instead of silently continuing in a broken state.
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[unhandled-rejection]', reason);
  });

  return server;
}

if (require.main === module) {
  main();
}

module.exports = { main };
