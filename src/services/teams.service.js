'use strict';

const teamsRepo = require('../db/repositories/teams.repo');
const { resolveLocation } = require('./location.service');
const { forbidden, notFound, ERROR_CODES } = require('../lib/errors');
const {
  validateTeamName,
  validatePracticeDays,
  validatePracticeTime,
  validateLocation,
} = require('../lib/validate');
const { nowIso } = require('../lib/time');

/**
 * Teams service -- the single place where team ownership is enforced (CHECK 3).
 *
 * `authorizeTeamAccess` is the chokepoint: EVERY handler that touches a specific
 * team calls it before reading or writing. It deliberately performs the lookup
 * by primary key first so the two failure modes stay distinguishable (CHECK 7):
 *
 *   team row missing                -> 404 TEAM_NOT_FOUND
 *   team row owned by another coach -> 403 TEAM_FORBIDDEN  (no team data returned)
 *
 * Mutations additionally carry `owner_id` in their own SQL WHERE clause
 * (`teamsRepo.updateOwned` / `teamsRepo.deleteOwned`), so ownership is enforced
 * twice: in the service and in the query that performs the write.
 */

const WEEKDAY_NAMES = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

/** Public shape of a team. Never includes credentials; the owner is the caller. */
function toTeamDto(team) {
  return {
    id: team.id,
    ownerId: team.ownerId,
    name: team.name,
    location: {
      type: team.locationType,
      query: team.locationQuery,
      resolvedName: team.resolvedName,
      latitude: team.latitude,
      longitude: team.longitude,
    },
    timezone: team.timezone,
    practiceDays: team.practiceDays,
    practiceDayNames: team.practiceDays.map((day) => WEEKDAY_NAMES[day]),
    practiceTime: team.practiceTime,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

/**
 * THE ownership gate (CHECK 3 + CHECK 7).
 *
 * @throws {AppError} 404 when no such team exists, 403 when it belongs to someone else
 */
function authorizeTeamAccess(db, teamId, authenticatedUserId) {
  const team = teamsRepo.findById(db, teamId);

  if (!team) {
    throw notFound(ERROR_CODES.TEAM_NOT_FOUND, 'No team exists with that id.');
  }

  if (team.ownerId !== authenticatedUserId) {
    // Another coach's team: nothing about it is disclosed -- not the name, not
    // the location, not even its existence beyond this status code.
    throw forbidden(
      ERROR_CODES.TEAM_FORBIDDEN,
      'This team belongs to another coach and cannot be accessed.',
    );
  }

  return team;
}

/** List only the authenticated coach's teams -- the query filters by owner_id. */
function listTeams(db, ownerId) {
  return teamsRepo.listByOwner(db, ownerId).map(toTeamDto);
}

/** Create a team for the authenticated coach, resolving the location server-side. */
async function createTeam(db, ownerId, payload, { geocodingService, weatherService }) {
  const name = validateTeamName(payload.name);
  const location = validateLocation(payload, { field: 'location' });
  const practiceDays = validatePracticeDays(payload.practiceDays);
  const practiceTime = validatePracticeTime(payload.practiceTime);

  const resolved = await resolveLocation(location, { geocodingService, weatherService });

  const team = teamsRepo.insertTeam(db, {
    ownerId,
    name,
    locationType: resolved.locationType,
    locationQuery: resolved.locationQuery,
    latitude: resolved.latitude,
    longitude: resolved.longitude,
    resolvedName: resolved.resolvedName,
    timezone: resolved.timezone,
    practiceDays,
    practiceTime,
  });

  return toTeamDto(team);
}

/** Read one team, proving the caller owns it. */
function getTeamForCoach(db, teamId, ownerId) {
  return toTeamDto(authorizeTeamAccess(db, teamId, ownerId));
}

/**
 * Partial update. Only the fields present in the payload are changed; the
 * location is re-resolved server-side whenever location fields are sent.
 */
async function updateTeam(db, teamId, ownerId, payload, { geocodingService, weatherService }) {
  const existing = authorizeTeamAccess(db, teamId, ownerId);

  const name = payload.name === undefined ? existing.name : validateTeamName(payload.name);

  const practiceDays =
    payload.practiceDays === undefined
      ? existing.practiceDays
      : validatePracticeDays(payload.practiceDays);

  const practiceTime =
    payload.practiceTime === undefined
      ? existing.practiceTime
      : validatePracticeTime(payload.practiceTime);

  const locationProvided =
    payload.location !== undefined ||
    payload.latitude !== undefined ||
    payload.lat !== undefined ||
    payload.longitude !== undefined ||
    payload.lon !== undefined ||
    payload.lng !== undefined ||
    payload.timezone !== undefined;

  let resolved;
  if (locationProvided) {
    const location = validateLocation(payload, { field: 'location' });
    resolved = await resolveLocation(location, { geocodingService, weatherService });
  } else {
    resolved = {
      locationType: existing.locationType,
      locationQuery: existing.locationQuery,
      latitude: existing.latitude,
      longitude: existing.longitude,
      resolvedName: existing.resolvedName,
      timezone: existing.timezone,
    };
  }

  const updated = teamsRepo.updateOwned(
    db,
    teamId,
    ownerId,
    { name, practiceDays, practiceTime, ...resolved },
    nowIso(),
  );

  // updateOwned filters on owner_id, so a null here means the row vanished
  // between the authorisation check and the write.
  if (!updated) {
    throw notFound(ERROR_CODES.TEAM_NOT_FOUND, 'No team exists with that id.');
  }

  return toTeamDto(updated);
}

/** Delete one team (and, via ON DELETE CASCADE, its recommendations). */
function deleteTeam(db, teamId, ownerId) {
  const existing = authorizeTeamAccess(db, teamId, ownerId);

  const changes = teamsRepo.deleteOwned(db, teamId, ownerId);
  if (changes === 0) {
    throw notFound(ERROR_CODES.TEAM_NOT_FOUND, 'No team exists with that id.');
  }

  return toTeamDto(existing);
}

module.exports = {
  WEEKDAY_NAMES,
  toTeamDto,
  authorizeTeamAccess,
  listTeams,
  createTeam,
  getTeamForCoach,
  updateTeam,
  deleteTeam,
};
