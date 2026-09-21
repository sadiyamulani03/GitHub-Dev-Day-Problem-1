'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { openDatabase } = require('../src/db');

const SRC_DIR = path.join(__dirname, '..', 'src');

/** Recursively collect every .js file under src/. */
function sourceFiles(dir, collected = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, collected);
    } else if (entry.name.endsWith('.js')) {
      collected.push(full);
    }
  }
  return collected;
}

// ---------------------------------------------------------------------------
// CHECK 6: parameterization. These are static checks of our own source, so the
// guarantee is re-proved on every run instead of being asserted by hand.
// ---------------------------------------------------------------------------

test('CHECK 6: no SQL statement text is ever assembled from interpolated parts', () => {
  const sqlKeywords = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b/i;
  const templateLiteral = /`[^`]*`/gs;
  const violations = [];

  for (const file of sourceFiles(SRC_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.match(templateLiteral) || []) {
      if (sqlKeywords.test(match) && match.includes('${')) {
        violations.push(`${path.relative(SRC_DIR, file)}: ${match.split('\n')[0].trim()}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `SQL must never be built from a template with interpolated parts, found:\n${violations.join('\n')}`,
  );
});

test('CHECK 6: every database call binds parameters instead of inlining values', () => {
  const violations = [];

  for (const file of sourceFiles(SRC_DIR)) {
    const source = fs.readFileSync(file, 'utf8');

    // `db.exec` runs multiple statements and cannot take parameters, so it must
    // only ever receive a static string (the schema file, in our case).
    for (const match of source.match(/\.exec\(([^)]*)\)/g) || []) {
      if (/\$\{|\+/.test(match)) {
        violations.push(`${path.relative(SRC_DIR, file)}: ${match}`);
      }
    }

    // A template literal handed straight to prepare/run/get/all would be a
    // dynamically built statement.
    for (const match of source.match(/\.(prepare|run|get|all)\(\s*`/g) || []) {
      violations.push(`${path.relative(SRC_DIR, file)}: ${match}`);
    }
  }

  assert.deepEqual(violations, [], violations.join('\n'));
});

test('CHECK 6: repository statements use placeholders for every bound value', () => {
  const repoDir = path.join(SRC_DIR, 'db', 'repositories');

  for (const file of fs.readdirSync(repoDir)) {
    const source = fs.readFileSync(path.join(repoDir, file), 'utf8');

    for (const statement of source.match(/`[^`]*`/gs) || []) {
      if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(statement)) {
        continue;
      }
      // A statement containing a quoted literal would be a value baked in by
      // hand; our repositories only ever use ? placeholders.
      assert.equal(
        /'\w+'/.test(statement),
        false,
        `${file}: statement appears to inline a literal value instead of a placeholder:\n${statement}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// CHECK 4: the database schema itself enforces uniqueness and integrity.
// ---------------------------------------------------------------------------

const INSERT_TEAM_SQL = `INSERT INTO teams (owner_id, name, location_type, latitude, longitude,
  resolved_name, timezone, practice_days, practice_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_RECOMMENDATION_SQL = `INSERT INTO recommendations (
  team_id, practice_date, practice_time, temperature_c, precipitation_probability,
  precipitation_mm, wind_speed_kph, weather_code, weather_provider, weather_fetched_at,
  forecast_json, note, reasoning_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function seedTeam(db, { ownerId = 1, name = 'Seed FC' } = {}) {
  return Number(
    db
      .prepare(INSERT_TEAM_SQL)
      .run(ownerId, name, 'place', 30.2, -97.7, 'Austin, Texas', 'America/Chicago', '[1,3]', '17:30')
      .lastInsertRowid,
  );
}

function recommendationValues(teamId, note) {
  return [
    teamId,
    '2026-09-21',
    '17:30',
    20,
    0,
    0,
    0,
    0,
    'test',
    '2026-09-21T12:00:00.000Z',
    '{}',
    note,
    '[]',
    '2026-09-21T12:00:00.000Z',
  ];
}

test('CHECK 4: the schema declares a UNIQUE constraint on (team_id, practice_date)', () => {
  const db = openDatabase(':memory:');

  const tableSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recommendations'")
    .get().sql;

  assert.match(tableSql, /UNIQUE\s*\(\s*team_id\s*,\s*practice_date\s*\)/i);

  // The constraint is also backed by a unique index on exactly those columns.
  // (PRAGMA arguments cannot be bound, and this name comes from SQLite itself.)
  const indexes = db.prepare('PRAGMA index_list(recommendations)').all();
  const uniqueIndex = indexes.find((index) => index.unique === 1 && index.origin === 'u');
  assert.ok(uniqueIndex, 'a database-generated unique index exists');

  const indexedColumns = db.prepare(`PRAGMA index_info(${uniqueIndex.name})`).all();
  assert.deepEqual(
    indexedColumns.map((column) => column.name),
    ['team_id', 'practice_date'],
  );

  db.close();
});

test('CHECK 4: the database rejects a duplicate write with no application logic involved', () => {
  const db = openDatabase(':memory:');

  db.prepare('INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)').run(
    'unique@example.com',
    'Coach',
    'scrypt-hash-placeholder',
  );
  const teamId = seedTeam(db);

  const insert = db.prepare(INSERT_RECOMMENDATION_SQL);
  insert.run(...recommendationValues(teamId, 'first'));

  assert.throws(
    () => insert.run(...recommendationValues(teamId, 'second')),
    (error) => error.code === 'SQLITE_CONSTRAINT_UNIQUE',
  );

  const upsert = db.prepare(`${INSERT_RECOMMENDATION_SQL} ON CONFLICT (team_id, practice_date) DO NOTHING`);
  assert.equal(upsert.run(...recommendationValues(teamId, 'third')).changes, 0);

  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM recommendations').get().total, 1);
  assert.equal(db.prepare('SELECT note FROM recommendations').get().note, 'first');

  db.close();
});

test('schema integrity: foreign keys, cascades, check constraints and indexes', () => {
  const db = openDatabase(':memory:');

  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

  db.prepare('INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)').run(
    'fk@example.com',
    'Coach',
    'scrypt-hash-placeholder',
  );

  // A team cannot reference a nonexistent owner.
  assert.throws(
    () => seedTeam(db, { ownerId: 999, name: 'Orphan FC' }),
    (error) => error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY',
  );

  // Out-of-range coordinates are refused by the table itself (CHECK 5 defence in depth).
  assert.throws(
    () =>
      db
        .prepare(INSERT_TEAM_SQL)
        .run(1, 'Bad Coords', 'coordinates', 120, 10, 'x', 'UTC', '[1]', '10:00'),
    (error) => error.code === 'SQLITE_CONSTRAINT_CHECK',
  );

  // A malformed practice date cannot be stored either.
  const badDateValues = recommendationValues(seedTeam(db, { name: 'Date Guard FC' }), 'x');
  badDateValues[1] = 'today';
  assert.throws(
    () => db.prepare(INSERT_RECOMMENDATION_SQL).run(...badDateValues),
    (error) => error.code === 'SQLITE_CONSTRAINT_CHECK',
  );

  // Deletes cascade from users -> teams -> recommendations.
  const teamId = seedTeam(db, { name: 'Cascade FC' });
  db.prepare(INSERT_RECOMMENDATION_SQL).run(...recommendationValues(teamId, 'x'));
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM recommendations').get().total, 1);

  db.prepare('DELETE FROM users WHERE id = ?').run(1);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM teams').get().total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM recommendations').get().total, 0);

  // The indexes that make owner-scoped and per-team reads cheap exist.
  const teamIndexes = db.prepare('PRAGMA index_list(teams)').all().map((index) => index.name);
  const recommendationIndexes = db
    .prepare('PRAGMA index_list(recommendations)')
    .all()
    .map((index) => index.name);

  assert.ok(teamIndexes.some((name) => /owner/i.test(name)), 'teams are indexed by owner');
  assert.ok(
    recommendationIndexes.some((name) => /team/i.test(name)),
    'recommendations are indexed by team',
  );

  db.close();
});

test('schema: users and sessions have their own uniqueness guarantees', () => {
  const db = openDatabase(':memory:');

  db.prepare('INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)').run(
    'dupe@example.com',
    'Coach',
    'scrypt-hash-placeholder',
  );

  // The UNIQUE index on users.email backs the 409 on duplicate registration,
  // including when two registrations race.
  assert.throws(
    () =>
      db
        .prepare('INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)')
        .run('dupe@example.com', 'Someone', 'scrypt-hash-placeholder'),
    (error) => error.code === 'SQLITE_CONSTRAINT_UNIQUE',
  );

  const insertSession = db.prepare(
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
  );
  insertSession.run(1, 'digest-1', '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
  assert.throws(
    () => insertSession.run(1, 'digest-1', '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'),
    (error) => error.code === 'SQLITE_CONSTRAINT_UNIQUE',
  );

  db.close();
});
