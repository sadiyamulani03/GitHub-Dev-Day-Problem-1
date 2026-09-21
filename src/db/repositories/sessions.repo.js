'use strict';

/**
 * Sessions repository -- server-side session storage.
 *
 * The cookie carries a random opaque token; only its SHA-256 digest is stored
 * here, so a leaked database cannot be replayed as a valid session cookie.
 * All statements are parameterized (CHECK 6).
 */

const INSERT_SESSION = `
  INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`;

// Ownership/identity for a request comes from this join: the session token is
// the only thing the client sends, and the user row is resolved by the server.
const SELECT_SESSION_WITH_USER = `
  SELECT s.id            AS session_id,
         s.user_id       AS user_id,
         s.expires_at    AS expires_at,
         u.email         AS email,
         u.display_name  AS display_name,
         u.created_at    AS user_created_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = ?
     AND s.expires_at > ?
`;

const DELETE_BY_TOKEN_HASH = `DELETE FROM sessions WHERE token_hash = ?`;
const DELETE_EXPIRED = `DELETE FROM sessions WHERE expires_at <= ?`;
const DELETE_FOR_USER = `DELETE FROM sessions WHERE user_id = ?`;

function insertSession(db, { userId, tokenHash, createdAt, expiresAt }) {
  db.prepare(INSERT_SESSION).run(userId, tokenHash, createdAt, expiresAt);
}

/** Resolve a session (and its coach) from a token digest, ignoring expired ones. */
function findSessionWithUser(db, tokenHash, nowIso) {
  const row = db.prepare(SELECT_SESSION_WITH_USER).get(tokenHash, nowIso);
  if (!row) {
    return null;
  }
  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.user_created_at,
    },
  };
}

function deleteByTokenHash(db, tokenHash) {
  return db.prepare(DELETE_BY_TOKEN_HASH).run(tokenHash).changes;
}

function deleteForUser(db, userId) {
  return db.prepare(DELETE_FOR_USER).run(userId).changes;
}

function deleteExpired(db, nowIso) {
  return db.prepare(DELETE_EXPIRED).run(nowIso).changes;
}

module.exports = {
  insertSession,
  findSessionWithUser,
  deleteByTokenHash,
  deleteForUser,
  deleteExpired,
};
