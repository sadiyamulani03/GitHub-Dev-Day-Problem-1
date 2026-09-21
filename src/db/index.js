'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * Open a SQLite database and apply the schema.
 *
 * `better-sqlite3` is used deliberately: it exposes real prepared statements
 * (`db.prepare(sql).run(...params)`), which is how CHECK 6 is satisfied -- no
 * SQL string ever contains a variable. It is also synchronous, so two requests
 * cannot interleave inside a single statement, and the UNIQUE constraint in
 * `schema.sql` does the duplicate prevention (CHECK 4).
 *
 * @param {string} databasePath absolute path, or ':memory:' for tests
 */
function openDatabase(databasePath) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);

  // Enforce foreign keys (off by default in SQLite).
  db.pragma('foreign_keys = ON');
  // Wait rather than throw when another connection holds the write lock.
  db.pragma('busy_timeout = 5000');
  if (databasePath !== ':memory:') {
    // WAL keeps readers unblocked while a recommendation is being written.
    db.pragma('journal_mode = WAL');
  }

  // The schema file is static (no interpolation) and fully idempotent.
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  return db;
}

module.exports = { openDatabase, SCHEMA_PATH };
