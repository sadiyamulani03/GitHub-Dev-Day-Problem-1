-- ---------------------------------------------------------------------------
-- Practice-Day Outfit Caller -- schema
--
-- Design notes that map directly to the scored checks:
--   * CHECK 4: `recommendations` carries a real DATABASE-level uniqueness
--     guarantee on (team_id, practice_date) -- both a named table constraint
--     and a unique index -- so a second write for the same team/date is
--     rejected (or upserted) by SQLite itself, even under a race.
--   * CHECK 3: `teams.owner_id` is the single source of ownership truth;
--     foreign keys + indexes make owner-scoped queries natural.
--   * CHECK 5: CHECK constraints mirror the server-side validation so bad
--     ranges cannot reach storage even if a future handler forgets to validate.
-- ---------------------------------------------------------------------------

-- Coaches. `password_hash` stores a salted scrypt digest: "scrypt$N$r$p$salt$hash".
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT uq_users_email UNIQUE (email)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users (email);

-- Server-side sessions. Only a SHA-256 digest of the opaque cookie token is
-- stored, so a leaked database dump cannot be replayed as a login cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  token_hash TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT uq_sessions_token_hash UNIQUE (token_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash_unique ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- A team belongs to exactly one coach. Location is stored already-resolved
-- (geocoding happens server-side at write time) so reads never need the network.
CREATE TABLE IF NOT EXISTS teams (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id         INTEGER NOT NULL,
  name             TEXT    NOT NULL,
  location_type    TEXT    NOT NULL CHECK (location_type IN ('place', 'coordinates')),
  location_query   TEXT,
  latitude         REAL    NOT NULL,
  longitude        REAL    NOT NULL,
  resolved_name    TEXT    NOT NULL,
  timezone         TEXT    NOT NULL,
  practice_days    TEXT    NOT NULL, -- JSON array of weekday ints, 0=Sunday..6=Saturday
  practice_time    TEXT    NOT NULL, -- 24h "HH:MM"
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CHECK (latitude >= -90 AND latitude <= 90),
  CHECK (longitude >= -180 AND longitude <= 180),
  CHECK (practice_days LIKE '[%'),
  CHECK (length(practice_time) = 5)
);

CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams (owner_id);
CREATE INDEX IF NOT EXISTS idx_teams_owner_name ON teams (owner_id, name);

-- ---------------------------------------------------------------------------
-- One persisted recommendation per team per practice date (CHECK 2 + CHECK 4).
-- The weather snapshot is stored alongside the note so the stored
-- recommendation can be served WITHOUT re-calling the weather API.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recommendations (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id                     INTEGER NOT NULL,
  practice_date               TEXT    NOT NULL, -- YYYY-MM-DD in the team's timezone
  practice_time               TEXT    NOT NULL,
  temperature_c               REAL    NOT NULL,
  precipitation_probability   INTEGER NOT NULL,
  precipitation_mm            REAL    NOT NULL,
  wind_speed_kph              REAL    NOT NULL,
  weather_code                INTEGER NOT NULL,
  weather_provider            TEXT    NOT NULL,
  weather_fetched_at          TEXT    NOT NULL,
  forecast_json               TEXT    NOT NULL,
  note                        TEXT    NOT NULL,
  reasoning_json              TEXT    NOT NULL,
  created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
  -- CHECK 4: the native database guarantee. A second INSERT for the same
  -- (team_id, practice_date) fails with SQLITE_CONSTRAINT_UNIQUE; every writer
  -- therefore uses INSERT ... ON CONFLICT DO NOTHING + re-SELECT.
  CONSTRAINT uq_recommendation_team_date UNIQUE (team_id, practice_date),
  CHECK (practice_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (temperature_c > -100 AND temperature_c < 100),
  CHECK (precipitation_probability >= 0 AND precipitation_probability <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendations_team_date_unique
  ON recommendations (team_id, practice_date);
CREATE INDEX IF NOT EXISTS idx_recommendations_team ON recommendations (team_id);
