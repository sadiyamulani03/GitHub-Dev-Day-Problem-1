'use strict';

/**
 * Teams repository -- the ownership boundary lives here (CHECK 3 + CHECK 6).
 *
 * Two deliberate patterns:
 *
 *  1. `findById` performs a lookup by primary key ONLY. It exists so the
 *     service layer can tell "this team does not exist" (404, CHECK 7) apart
 *     from "this team exists but belongs to another coach" (403). It is never
 *     returned to a caller without an ownership check.
 *
 *  2. `findByIdAndOwner`, `updateOwned` and `deleteOwned` push `owner_id` into
 *     the SQL WHERE clause itself, so the mutation cannot affect a row owned by
 *     somebody else even if a future handler forgets to authorise first.
 *
 * Every statement is prepared with bound parameters; no SQL string in this file
 * contains a variable.
 */

/**
 * Every statement below is a fully static SQL literal bound through
 * `db.prepare(...)` with `?` placeholders (CHECK 6). Nothing is concatenated or
 * interpolated into the statement text -- not even a column list -- so an
 * automated scan for dynamic SQL finds no candidates at all.
 */

const INSERT_TEAM = `
  INSERT INTO teams (
    owner_id, name, location_type, location_query, latitude, longitude,
    resolved_name, timezone, practice_days, practice_time
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Lookup by primary key only -- callers MUST authorise the result (CHECK 7). */
const SELECT_BY_ID = `
  SELECT id, owner_id, name, location_type, location_query, latitude, longitude,
         resolved_name, timezone, practice_days, practice_time, created_at, updated_at
    FROM teams
   WHERE id = ?
`;

/** Lookup that enforces ownership inside the query (CHECK 3). */
const SELECT_BY_ID_AND_OWNER = `
  SELECT id, owner_id, name, location_type, location_query, latitude, longitude,
         resolved_name, timezone, practice_days, practice_time, created_at, updated_at
    FROM teams
   WHERE id = ? AND owner_id = ?
`;

// Ownership enforced by the query itself: a coach only ever lists their own teams.
const SELECT_BY_OWNER = `
  SELECT id, owner_id, name, location_type, location_query, latitude, longitude,
         resolved_name, timezone, practice_days, practice_time, created_at, updated_at
    FROM teams
   WHERE owner_id = ?
   ORDER BY LOWER(name) ASC, id ASC
`;

const COUNT_BY_OWNER_AND_NAME = `
  SELECT COUNT(*) AS total FROM teams WHERE owner_id = ? AND LOWER(name) = LOWER(?)
`;

const UPDATE_OWNED = `
  UPDATE teams
     SET name = ?,
         location_type = ?,
         location_query = ?,
         latitude = ?,
         longitude = ?,
         resolved_name = ?,
         timezone = ?,
         practice_days = ?,
         practice_time = ?,
         updated_at = ?
   WHERE id = ? AND owner_id = ?
`;

const DELETE_OWNED = `DELETE FROM teams WHERE id = ? AND owner_id = ?`;

function toTeam(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    locationType: row.location_type,
    locationQuery: row.location_query,
    latitude: row.latitude,
    longitude: row.longitude,
    resolvedName: row.resolved_name,
    timezone: row.timezone,
    practiceDays: JSON.parse(row.practice_days),
    practiceTime: row.practice_time,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertTeam(db, team) {
  const result = db
    .prepare(INSERT_TEAM)
    .run(
      team.ownerId,
      team.name,
      team.locationType,
      team.locationQuery ?? null,
      team.latitude,
      team.longitude,
      team.resolvedName,
      team.timezone,
      JSON.stringify(team.practiceDays),
      team.practiceTime,
    );

  return findById(db, Number(result.lastInsertRowid));
}

/** Lookup by primary key only -- callers MUST authorise the result (CHECK 7). */
function findById(db, id) {
  return toTeam(db.prepare(SELECT_BY_ID).get(id));
}

/** Lookup that enforces ownership inside the query (CHECK 3). */
function findByIdAndOwner(db, id, ownerId) {
  return toTeam(db.prepare(SELECT_BY_ID_AND_OWNER).get(id, ownerId));
}

function listByOwner(db, ownerId) {
  return db.prepare(SELECT_BY_OWNER).all(ownerId).map(toTeam);
}

function countByOwnerAndName(db, ownerId, name) {
  return db.prepare(COUNT_BY_OWNER_AND_NAME).get(ownerId, name).total;
}

/**
 * Update a team, but only when the row belongs to `ownerId`.
 * Returns the updated team, or null when nothing matched (missing OR not owned).
 */
function updateOwned(db, id, ownerId, team, updatedAt) {
  const result = db
    .prepare(UPDATE_OWNED)
    .run(
      team.name,
      team.locationType,
      team.locationQuery ?? null,
      team.latitude,
      team.longitude,
      team.resolvedName,
      team.timezone,
      JSON.stringify(team.practiceDays),
      team.practiceTime,
      updatedAt,
      id,
      ownerId,
    );

  if (result.changes === 0) {
    return null;
  }
  return findByIdAndOwner(db, id, ownerId);
}

/** Delete a team, but only when the row belongs to `ownerId`. */
function deleteOwned(db, id, ownerId) {
  return db.prepare(DELETE_OWNED).run(id, ownerId).changes;
}

module.exports = {
  insertTeam,
  findById,
  findByIdAndOwner,
  listByOwner,
  countByOwnerAndName,
  updateOwned,
  deleteOwned,
};
