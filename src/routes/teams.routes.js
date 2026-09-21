'use strict';

const express = require('express');
const teamsService = require('../services/teams.service');
const recommendationService = require('../services/recommendation.service');
const recommendationsRepo = require('../db/repositories/recommendations.repo');
const { badRequest, ERROR_CODES } = require('../lib/errors');
const { requirePlainObject, validateId, validatePracticeDate } = require('../lib/validate');

/**
 * Team + recommendation routes.
 *
 * Every route here is protected twice:
 *   1. `auth.requireAuth` proves there is a logged-in coach (route level).
 *   2. The handler calls `teamsService.authorizeTeamAccess(...)` (or a service
 *      method that does it) so the *record* is checked against the authenticated
 *      coach id. Route-level auth alone is NOT treated as authorisation.
 *
 * Nothing in this file reads a user id from the request body: the coach's
 * identity is `req.user.id`, which came from the server-side session.
 */

/**
 * Forecast-like keys a client must never be able to inject (CHECK 1).
 * These are rejected outright rather than silently ignored, so no caller can
 * ever believe its numbers were used.
 */
const CLIENT_FORECAST_KEYS = Object.freeze([
  'temperature',
  'temperaturec',
  'temperature_c',
  'temp',
  'feelslike',
  'precipitation',
  'precipitationprobability',
  'precipitation_mm',
  'precipitationmm',
  'rain',
  'rainchance',
  'rain_chance',
  'snow',
  'wind',
  'windspeed',
  'windspeedkph',
  'wind_speed_kph',
  'weather',
  'weathercode',
  'weather_code',
  'forecast',
  'condition',
  'humidity',
  'note',
  'recommendation',
  'outfit',
]);

/** Reject any attempt to hand the backend a forecast. */
function assertNoClientForecast(body, routeName) {
  if (body === undefined || body === null) {
    return;
  }
  const supplied = Object.keys(body).filter((key) =>
    CLIENT_FORECAST_KEYS.includes(key.toLowerCase().replace(/[\s_]/g, '')),
  );
  if (supplied.length > 0) {
    throw badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      'The forecast is fetched server-side from a weather API and cannot be supplied by the client.',
      supplied.map((field) => ({ field, issue: 'client_supplied_forecast', route: routeName })),
    );
  }
}

function isValidPracticeDay(team, practiceDate) {
  return team.practiceDays.includes(new Date(`${practiceDate}T00:00:00Z`).getUTCDay());
}

function createTeamsRouter({
  db,
  config,
  auth,
  weatherService,
  geocodingService,
  recommendationDeps = {},
}) {
  const router = express.Router();
  const deps = { geocodingService, weatherService, ...recommendationDeps };

  // Every route in this router requires a session.
  router.use(auth.requireAuth);

  // --- Create a team --------------------------------------------------------
  router.post('/teams', async (req, res, next) => {
    try {
      const body = requirePlainObject(req.body);
      const team = await teamsService.createTeam(db, req.user.id, body, {
        geocodingService,
        weatherService,
      });
      res.status(201).json({ team });
    } catch (error) {
      next(error);
    }
  });

  // --- List the coach's own teams ------------------------------------------
  router.get('/teams', (req, res, next) => {
    try {
      // The query filters by owner_id, so another coach's teams are never listed.
      const teams = teamsService.listTeams(db, req.user.id);
      res.status(200).json({ teams, count: teams.length });
    } catch (error) {
      next(error);
    }
  });

  // --- Read one team -------------------------------------------------------
  router.get('/teams/:teamId', (req, res, next) => {
    try {
      const teamId = validateId(req.params.teamId, 'teamId');
      // 404 when the row is missing, 403 when it belongs to another coach.
      const team = teamsService.getTeamForCoach(db, teamId, req.user.id);
      const practiceDate = recommendationService.todayInTeamTimeZone(team);
      const stored = recommendationService.findRecommendation(db, teamId, practiceDate, req.user.id);

      res.status(200).json({
        team,
        today: {
          practiceDate,
          isPracticeDay: isValidPracticeDay(team, practiceDate),
          hasRecommendation: Boolean(stored),
          recommendationId: stored ? stored.id : null,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  // --- Update one team (PATCH and PUT share one handler) -------------------
  const updateTeam = async (req, res, next) => {
    try {
      const teamId = validateId(req.params.teamId, 'teamId');
      const body = requirePlainObject(req.body);
      const team = await teamsService.updateTeam(db, teamId, req.user.id, body, {
        geocodingService,
        weatherService,
      });
      res.status(200).json({ team });
    } catch (error) {
      next(error);
    }
  };

  router.patch('/teams/:teamId', updateTeam);
  router.put('/teams/:teamId', updateTeam);

  // --- Delete one team -----------------------------------------------------
  router.delete('/teams/:teamId', (req, res, next) => {
    try {
      const teamId = validateId(req.params.teamId, 'teamId');
      const team = teamsService.deleteTeam(db, teamId, req.user.id);
      res.status(200).json({ deleted: true, team });
    } catch (error) {
      next(error);
    }
  });

  // --- Generate (or re-use) today's recommendation -------------------------
  router.post('/teams/:teamId/recommendation', async (req, res, next) => {
    try {
      const teamId = validateId(req.params.teamId, 'teamId');
      const body = requirePlainObject(req.body);

      // Ownership is checked against the database record FIRST, so a missing
      // team is always 404 and another coach's team is always 403 regardless of
      // what the body contains (CHECK 3 + CHECK 7).
      const team = teamsService.authorizeTeamAccess(db, teamId, req.user.id);

      // A client may choose the date, but never the weather.
      assertNoClientForecast(body, 'POST /teams/:teamId/recommendation');

      const rawDate =
        body.date === undefined ? req.query.date : validatePracticeDate(body.date, 'date');

      const { recommendation, created, practiceDate, isPracticeDay } =
        await recommendationService.getOrCreateRecommendation({
          db,
          team,
          ownerId: req.user.id,
          weatherService,
          durationMinutes: config.practiceDurationMinutes,
          rawDate,
        });

      res.status(created ? 201 : 200).json({
        // `created: false` (and `reused: true`) means the stored note for this
        // team/date was returned as-is -- this is how re-running the job avoids
        // producing a second, possibly-different note for the same practice.
        created,
        reused: !created,
        practiceDate,
        isPracticeDay,
        recommendation,
      });
    } catch (error) {
      next(error);
    }
  });

  // --- Read the stored recommendation (no weather call) --------------------
  router.get('/teams/:teamId/recommendation', (req, res, next) => {
    try {
      const teamId = validateId(req.params.teamId, 'teamId');
      const team = teamsService.authorizeTeamAccess(db, teamId, req.user.id);
      const practiceDate = recommendationService.resolvePracticeDate(team, req.query.date);

      // Reads storage only: this endpoint never calls the weather API.
      const recommendation = recommendationService.requireExistingRecommendation(
        db,
        teamId,
        practiceDate,
        req.user.id,
      );

      res.status(200).json({
        created: false,
        reused: true,
        practiceDate,
        recommendation,
      });
    } catch (error) {
      next(error);
    }
  });

  // --- Recommendation history for one team ---------------------------------
  router.get('/teams/:teamId/recommendations', (req, res, next) => {
    try {
      const teamId = validateId(req.params.teamId, 'teamId');
      teamsService.authorizeTeamAccess(db, teamId, req.user.id);

      const recommendations = recommendationsRepo.listLatestOwnedByTeam(db, teamId, req.user.id, 30);
      res.status(200).json({ recommendations, count: recommendations.length });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createTeamsRouter, CLIENT_FORECAST_KEYS, assertNoClientForecast };
