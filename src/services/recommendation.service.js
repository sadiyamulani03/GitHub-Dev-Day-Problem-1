'use strict';

const recommendationsRepo = require('../db/repositories/recommendations.repo');
const { buildOutfitRecommendation } = require('./outfit.engine');
const { notFound, badRequest, ERROR_CODES } = require('../lib/errors');
const { toDateInTimeZone, isIsoDate, daysBetween, timeToMinutes, nowIso } = require('../lib/time');

/**
 * Recommendation orchestration (CHECK 1, 2, 4).
 *
 * Guarantees:
 *   1. Weather always comes from the injected weather service, which calls the
 *      provider from the backend. No handler accepts a forecast from a client.
 *   2. At most ONE recommendation row exists per (team_id, practice_date). The
 *      row is written with `INSERT ... ON CONFLICT DO NOTHING`, and the winner
 *      is then re-read, so concurrent requests converge on the same row.
 *   3. Re-running for the same team/date returns the stored recommendation
 *      without calling the weather API again.
 */

/** How far around today a practice date may be requested. */
const MAX_DAYS_AHEAD = 15;
const MAX_DAYS_BEHIND = 1;

/** The practice date a team cares about right now: today in the team's timezone. */
function todayInTeamTimeZone(team, now = new Date()) {
  return toDateInTimeZone(now, team.timezone);
}

/**
 * Reject practice dates the provider cannot forecast, BEFORE any network call,
 * so a bad date is a clean 400 instead of an upstream 502.
 */
function assertSupportedPracticeDate(practiceDate, today) {
  const offset = daysBetween(today, practiceDate);
  if (offset > MAX_DAYS_AHEAD || offset < -MAX_DAYS_BEHIND) {
    throw badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      `"date" must be between ${MAX_DAYS_BEHIND} day before and ${MAX_DAYS_AHEAD} days after today (${today}).`,
      [{ field: 'date', issue: 'out_of_range', received: practiceDate, today }],
    );
  }
}

/** The practice date requested by the caller, or today in the team's timezone. */
function resolvePracticeDate(team, rawDate, now = new Date()) {
  const today = todayInTeamTimeZone(team, now);

  if (rawDate === undefined || rawDate === null || rawDate === '') {
    return today;
  }

  if (!isIsoDate(rawDate)) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, '"date" must be a real date in YYYY-MM-DD form.', [
      { field: 'date', issue: 'malformed_date', received: String(rawDate).slice(0, 32) },
    ]);
  }

  assertSupportedPracticeDate(rawDate, today);
  return rawDate;
}

/** Read the stored recommendation for a team/date. No weather call is made. */
function findRecommendation(db, teamId, practiceDate, ownerId) {
  return recommendationsRepo.findOwnedByTeamAndDate(db, teamId, practiceDate, ownerId);
}

/**
 * Get today's (or a requested day's) recommendation, creating it exactly once.
 *
 * @returns {Promise<{recommendation: object, created: boolean, practiceDate: string,
 *                    isPracticeDay: boolean}>}
 */
async function getOrCreateRecommendation({
  db,
  team,
  ownerId,
  weatherService,
  durationMinutes,
  rawDate,
  now = new Date(),
}) {
  const practiceDate = resolvePracticeDate(team, rawDate, now);
  const isPracticeDay = team.practiceDays.includes(
    new Date(`${practiceDate}T00:00:00Z`).getUTCDay(),
  );

  // (2/3) Already stored for this team + date? Return it untouched; the weather
  // API is NOT called again, so the note cannot silently change during the day.
  const existing = findRecommendation(db, team.id, practiceDate, ownerId);
  if (existing) {
    return { recommendation: existing, created: false, practiceDate, isPracticeDay };
  }

  // (1) Weather is fetched by the backend, for the team's own coordinates and
  // practice window. Client input cannot influence these numbers.
  const forecast = await weatherService.getPracticeForecast({
    latitude: team.latitude,
    longitude: team.longitude,
    practiceDate,
    practiceTime: team.practiceTime,
    durationMinutes,
  });

  const outfit = buildOutfitRecommendation(forecast);

  // (2) The database decides the winner. `insertIfAbsent` uses
  // ON CONFLICT (team_id, practice_date) DO NOTHING, so this is race-safe:
  // a losing concurrent request inserts nothing and falls through to the re-read.
  const changes = recommendationsRepo.insertIfAbsent(db, {
    teamId: team.id,
    practiceDate,
    practiceTime: team.practiceTime,
    temperatureC: forecast.temperatureC,
    precipitationProbability: forecast.precipitationProbability,
    precipitationMm: forecast.precipitationMm,
    windSpeedKph: forecast.windSpeedKph,
    weatherCode: forecast.weatherCode,
    weatherProvider: forecast.provider,
    weatherFetchedAt: forecast.fetchedAt,
    weather: forecast,
    note: outfit.note,
    reasoning: outfit.reasoning,
    createdAt: nowIso(),
  });

  // Re-read rather than trusting our own object: under a race this returns the
  // row the database kept, which is the same row the other request returned.
  const stored = findRecommendation(db, team.id, practiceDate, ownerId);
  if (!stored) {
    throw notFound(
      ERROR_CODES.RECOMMENDATION_NOT_FOUND,
      'The recommendation could not be persisted or read back.',
    );
  }

  return { recommendation: stored, created: changes === 1, practiceDate, isPracticeDay };
}

/** Used by the route that answers "is there already a note for today?". */
function requireExistingRecommendation(db, teamId, practiceDate, ownerId) {
  const recommendation = findRecommendation(db, teamId, practiceDate, ownerId);
  if (!recommendation) {
    throw notFound(
      ERROR_CODES.RECOMMENDATION_NOT_FOUND,
      `No recommendation has been generated for ${practiceDate} yet.`,
    );
  }
  return recommendation;
}

module.exports = {
  MAX_DAYS_AHEAD,
  MAX_DAYS_BEHIND,
  todayInTeamTimeZone,
  assertSupportedPracticeDate,
  resolvePracticeDate,
  findRecommendation,
  requireExistingRecommendation,
  getOrCreateRecommendation,
  timeToMinutes,
};
