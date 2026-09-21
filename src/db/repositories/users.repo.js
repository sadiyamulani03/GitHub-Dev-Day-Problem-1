'use strict';

/**
 * Users repository.
 *
 * Every statement is a prepared statement with bound parameters (CHECK 6):
 * no SQL string in this file ever contains a variable.
 */

const INSERT_USER = `
  INSERT INTO users (email, display_name, password_hash)
  VALUES (?, ?, ?)
`;

const SELECT_BY_EMAIL = `
  SELECT id, email, display_name, password_hash, created_at
    FROM users
   WHERE email = ?
`;

const SELECT_BY_ID = `
  SELECT id, email, display_name, password_hash, created_at
    FROM users
   WHERE id = ?
`;

function toUser(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

function insertUser(db, { email, displayName, passwordHash }) {
  const result = db.prepare(INSERT_USER).run(email, displayName, passwordHash);
  return findById(db, Number(result.lastInsertRowid));
}

function findByEmail(db, email) {
  return toUser(db.prepare(SELECT_BY_EMAIL).get(email));
}

function findById(db, id) {
  return toUser(db.prepare(SELECT_BY_ID).get(id));
}

module.exports = { insertUser, findByEmail, findById };
