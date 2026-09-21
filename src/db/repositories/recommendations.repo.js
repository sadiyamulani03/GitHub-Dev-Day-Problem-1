'use strict';

/**
 * Recommendations repository (CHECK 2 + CHECK 4 + CHECK 6).
 *
 * Duplicate prevention is a DATABASE guarantee, not an application check:
 *
 *   * `schema.sql` declares `CONSTRAINT uq_recommendation_team_date
 *     UNIQUE (team_id, practice_date)` plus a unique index.
 *   * `insertIfAbsent` uses `INSERT ... ON CONFLICT (team_id, practice_date)
 *     DO NOTHING`. If two requests race, SQLite lets exactly one insert win and
 *     the loser gets `changes === 0` instead of a duplicate row or an error.
 *   * The caller then re-reads the row, so both requests return the SAME
 *     persisted recommendation.
 *
 * All statements are parameterized.
 */

// Static SQL only: the shared column list is expanded here as a literal so no
// statement text is ever assembled from interpolated parts (CHECK 6).
const INSERT_IF_ABSENT = `
  INSERT INTO recommendations (
    team_id, practice_date, practice_time, temperature_c,
    precipitation_probability, precipitation_mm, wind_speed_kph, weather_code,
    weather_provider, weather_fetched_at, forecast_json, note, reasoning_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (team_id, practice_date) DO NOTHING
`;

const SELECT_BY_TEAM_AND_DATE = `
  SELECT id, team_id, practice_date, practice_time, temperature_c,
         precipitation_probability, precipitation_mm, wind_speed_kph, weather_code,
         weather_provider, weather_fetched_at, forecast_json, note, reasoning_json, created_at
    FROM recommendations
   WHERE team_id = ? AND practice_date = ?
`;

// Ownership is enforced in the query itself: the join cannot return a
// recommendation whose team is owned by another coach (CHECK 3).
const SELECT_OWNED_BY_TEAM_AND_DATE = `
  SELECT r.id, r.team_id, r.practice_date, r.practice_time, r.temperature_c,
         r.precipitation_probability, r.precipitation_mm, r.wind_speed_kph,
         r.weather_code, r.weather_provider, r.weather_fetched_at,
         r.forecast_json, r.note, r.reasoning_json, r.created_at
    FROM recommendations r
    JOIN teams t ON t.id = r.team_id
   WHERE r.team_id = ? AND r.practice_date = ? AND t.owner_id = ?
`;

const SELECT_LATEST_OWNED_BY_TEAM = `
  SELECT r.id, r.team_id, r.practice_date, r.practice_time, r.temperature_c,
         r.precipitation_probability, r.precipitation_mm, r.wind_speed_kph,
         r.weather_code, r.weather_provider, r.weather_fetched_at,
         r.forecast_json, r.note, r.reasoning_json, r.created_at
    FROM recommendations r
    JOIN teams t ON t.id = r.team_id
   WHERE r.team_id = ? AND t.owner_id = ?
   ORDER BY r.practice_date DESC
   LIMIT ?
`;

const COUNT_BY_TEAM_AND_DATE = `
  SELECT COUNT(*) AS total FROM recommendations WHERE team_id = ? AND practice_date = ?
`;

function toRecommendation(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    teamId: row.team_id,
    practiceDate: row.practice_date,
    practiceTime: row.practice_time,
    note: row.note,
    reasoning: JSON.parse(row.reasoning_json),
    weather: JSON.parse(row.forecast_json),
    weatherProvider: row.weather_provider,
    weatherFetchedAt: row.weather_fetched_at,
    temperatureC: row.temperature_c,
    precipitationProbability: row.precipitation_probability,
    precipitationMm: row.precipitation_mm,
    windSpeedKph: row.wind_speed_kph,
    weatherCode: row.weather_code,
    createdAt: row.created_at,
  };
}

/**
 * Insert a new recommendation for (team_id, practice_date).
 * @returns {number} 1 when this call created the row, 0 when a row already
 *   existed (including when a concurrent request won the race).
 */
function insertIfAbsent(db, recommendation) {
  const result = db
    .prepare(INSERT_IF_ABSENT)
    .run(
      recommendation.teamId,
      recommendation.practiceDate,
      recommendation.practiceTime,
      recommendation.temperatureC,
      recommendation.precipitationProbability,
      recommendation.precipitationMm,
      recommendation.windSpeedKph,
      recommendation.weatherCode,
      recommendation.weatherProvider,
      recommendation.weatherFetchedAt,
      JSON.stringify(recommendation.weather),
      recommendation.note,
      JSON.stringify(recommendation.reasoning),
      recommendation.createdAt,
    );

  return result.changes;
}

function findByTeamAndDate(db, teamId, practiceDate) {
  return toRecommendation(db.prepare(SELECT_BY_TEAM_AND_DATE).get(teamId, practiceDate));
}

/** Read a recommendation and prove ownership in one query (CHECK 3). */
function findOwnedByTeamAndDate(db, teamId, practiceDate, ownerId) {
  return toRecommendation(
    db.prepare(SELECT_OWNED_BY_TEAM_AND_DATE).get(teamId, practiceDate, ownerId),
  );
}

function listLatestOwnedByTeam(db, teamId, ownerId, limit = 10) {
  return db
    .prepare(SELECT_LATEST_OWNED_BY_TEAM)
    .all(teamId, ownerId, limit)
    .map(toRecommendation);
}

/**
 * Used by the tests (and the adversarial check script) to prove the database
 * itself refuses a duplicate for the same team and date.
 */
function countByTeamAndDate(db, teamId, practiceDate) {
  return db.prepare(COUNT_BY_TEAM_AND_DATE).get(teamId, practiceDate).total;
}

module.exports = {
  insertIfAbsent,
  findByTeamAndDate,
  findOwnedByTeamAndDate,
  listLatestOwnedByTeam,
  countByTeamAndDate,
};
