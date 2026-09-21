# Practice-Day Outfit Caller

A coach registers their team's practice field and schedule; the backend fetches the forecast for each practice date and generates a single persisted outfit/gear recommendation per team per date.

---

## Problem

Coaches need a quick, reliable "what to wear" call for practice that accounts for the actual weather at the team's field. The recommendation must be generated server-side from a real forecast, stored once per team per practice date, and private to the coach who owns the team.

---

## User Flow

1. **Coach registers/logs in** — creates a server-side session (HttpOnly cookie, SHA-256 token digest stored).
2. **Coach sees only their own teams** — team list is filtered by `owner_id` at the database level.
3. **Coach creates a team** — provides a place name (geocoded server-side) or coordinates; server validates and resolves to latitude/longitude/timezone.
4. **Coach requests a recommendation for a date** — backend calls Open-Meteo for the team's coordinates + practice window, aggregates the hourly forecast, runs the deterministic outfit engine, and persists the result.
5. **Re-running returns the stored note** — the DB unique constraint on `(team_id, practice_date)` prevents a second row; the existing recommendation is re-read and returned unchanged.

---

## Architecture

| Layer | Files |
|-------|-------|
| **Entry / Config** | `src/server.js`, `src/config.js`, `src/lib/env.js` |
| **HTTP / Middleware** | `src/app.js`, `src/middleware/auth.js`, `src/middleware/security.js`, `src/middleware/error.js` |
| **Auth** | `src/routes/auth.routes.js`, `src/services/auth.service.js`, `src/services/password.service.js`, `src/db/repositories/sessions.repo.js`, `src/db/repositories/users.repo.js` |
| **Teams** | `src/routes/teams.routes.js`, `src/services/teams.service.js`, `src/db/repositories/teams.repo.js` |
| **Recommendations** | `src/services/recommendation.service.js`, `src/db/repositories/recommendations.repo.js` |
| **Weather / Geocoding** | `src/services/weather.service.js`, `src/services/geocoding.service.js` |
| **Outfit Engine** | `src/services/outfit.engine.js` (pure, no I/O) |
| **Validation** | `src/lib/validate.js` |
| **DB** | `src/db/index.js`, `src/db/schema.sql` |

---

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | — | Create coach account, start session |
| POST | `/auth/login` | — | Start session |
| POST | `/auth/logout` | ✓ | Destroy session server-side, clear cookie |
| GET | `/me` | ✓ | Current coach identity |
| GET | `/teams` | ✓ | List coach's teams |
| POST | `/teams` | ✓ | Create team (server-side geocoding) |
| GET | `/teams/:id` | ✓ | Team detail + today's status |
| PATCH/PUT | `/teams/:id` | ✓ | Update team (re-geocode if location changes) |
| DELETE | `/teams/:id` | ✓ | Delete team (cascades to recommendations) |
| POST | `/teams/:id/recommendation` | ✓ | Generate/re-use recommendation for date |
| GET | `/teams/:id/recommendation` | ✓ | Read stored recommendation (no weather call) |
| GET | `/teams/:id/recommendations` | ✓ | History (latest 30) |

---

## Database Schema & Uniqueness

**Tables:** `users`, `sessions`, `teams`, `recommendations`

**Key constraints:**
- `users.email` — UNIQUE
- `sessions.token_hash` — UNIQUE
- `teams.owner_id` → `users.id` (FK, CASCADE)
- `recommendations.team_id` → `teams.id` (FK, CASCADE)
- **`recommendations(team_id, practice_date)` — UNIQUE constraint + unique index** (CHECK 4)

**Write path uses upsert:**
```sql
INSERT ... ON CONFLICT (team_id, practice_date) DO NOTHING
```
If a race occurs, the loser gets `changes === 0` and re-reads the winner's row.

---

## Ownership Enforcement (CHECK 3)

Every team-scoped route calls `teamsService.authorizeTeamAccess(db, teamId, userId)` **before** any read or write.

```js
// teams.service.js:66-83
const team = teamsRepo.findById(db, teamId);      // 1. Lookup by PK
if (!team) throw notFound(...);                   // → 404 TEAM_NOT_FOUND
if (team.ownerId !== userId) throw forbidden(...); // → 403 TEAM_FORBIDDEN
```

Mutations (`updateOwned`, `deleteOwned`) also include `owner_id` in the SQL `WHERE` clause as a second line of defence.

---

## Server-Side Location Validation (CHECK 5)

`validateLocation()` (`src/lib/validate.js:254-311`) accepts either:
- A place name string → server geocodes it via Open-Meteo geocoding API
- Coordinates (`latitude` + `longitude`) → validated to `[-90,90]` / `[-180,180]`

Rejects: missing, empty, over-length, malformed, control characters, SQL-like strings. The geocoding service (`geocoding.service.js:81-94`) also validates upstream coordinates before accepting them.

---

## Server-Side Weather Fetching (CHECK 1)

- The **only** place a forecast enters the system is `weatherService.getPracticeForecast()` (`weather.service.js:198-256`).
- Called exclusively from `recommendation.service.getOrCreateRecommendation()` using the **team's stored coordinates** and **practice window**.
- The API **rejects** any client-supplied forecast fields (`temperature`, `precipitation`, `wind`, `weather_code`, `note`, `outfit`, etc.) with `400 VALIDATION_ERROR` (`teams.routes.js:28-72`).

---

## Parameterized SQL (CHECK 6)

- Uses `better-sqlite3` prepared statements everywhere.
- **Zero** SQL string interpolation in repository files.
- Every `INSERT`, `UPDATE`, `DELETE`, `SELECT` uses `?` placeholders.
- Verified by static analysis tests: `tests/database.schema.test.js:30-73`.

---

## 404 vs 403 Distinction (CHECK 7)

`authorizeTeamAccess` performs a **primary-key lookup first**:
1. No row → `404 TEAM_NOT_FOUND`
2. Row exists, wrong owner → `403 TEAM_FORBIDDEN` (no team data leaked)

Tested on every team-scoped route: `tests/teams.ownership.test.js:116-145`.

---

## No Secrets in Repository (CHECK 8)

- `.env` is git-ignored (`.gitignore:4-7`).
- `.env.example` contains **only non-secret defaults** (port, DB path, keyless Open-Meteo URLs).
- Configuration loaded from environment at runtime (`src/config.js:31-47`).
- Upstream providers are **public, keyless** APIs.
- Secret scanner (`scripts/secret-scan.js`) runs in CI; strong patterns scanned in history, weak patterns only in working tree (test fixtures excluded).

---

## Security Considerations

- **Auth:** Server-side sessions; cookie is `HttpOnly; SameSite=Lax; Secure` in production. Token digest (SHA-256) stored, not raw token.
- **Passwords:** scrypt (N=16384, r=8, p=1) with per-password salt; constant-time verify; fake verify on unknown email to prevent enumeration.
- **Headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, restrictive CSP.
- **Input validation:** Strict server-side validation for every field; 20 KB JSON body limit; 413 on oversized payloads.
- **SQL safety:** 100% parameterized queries; foreign keys + cascades enforced by SQLite.
- **Error handling:** Consistent JSON envelope `{ error: { code, message, details? } }`; no stack traces or internal details leaked.

---

## Local Development

```bash
# 1. Clone
git clone https://github.com/sadiyamulani03/GitHub-Dev-Day-Problem-1.git
cd GitHub-Dev-Day-Problem-1

# 2. Install
npm ci

# 3. Configure (optional — defaults work for local dev)
cp .env.example .env
# edit .env if needed

# 4. Run
npm run dev       # auto-reload on change
# or
npm start         # production-like

# Server listens on http://localhost:3000 (default)
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/app.db` | SQLite file path (`:memory:` in tests) |
| `NODE_ENV` | `development` | `production` enables Secure cookie + HSTS |
| `SESSION_TTL_HOURS` | `168` | Session lifetime |
| `PRACTICE_DURATION_MINUTES` | `90` | Forecast window length |
| `WEATHER_BASE_URL` | `https://api.open-meteo.com/v1` | Override for proxy/mock |
| `GEOCODING_BASE_URL` | `https://geocoding-api.open-meteo.com/v1` | Override for proxy/mock |
| `UPSTREAM_TIMEOUT_MS` | `8000` | Upstream HTTP timeout |
| `RUN_LIVE_WEATHER` | `0` | Set `1` to enable live integration test |

---

## Testing

```bash
# Unit + integration tests (offline, deterministic, in-memory DB)
npm test

# Live Open-Meteo integration test (requires network)
npm run test:live

# Adversarial/security checks
npm run attack

# Secret scan (CHECK 8)
npm run audit:secrets
```

**Verified results:**
- ✅ 116 / 116 tests pass
- ✅ Secret scan: PASS (no credentials in tracked files or history)

---

## Challenge Acceptance Criteria

| # | Requirement | Implementation Evidence |
|---|-------------|------------------------|
| 1 | **Server-side forecast** — forecast fetched by backend, never trusted from client | `weather.service.js:198-256` (sole fetch point); `teams.routes.js:28-72` (rejects client forecast keys); `recommendation.service.js:97-103` (calls with stored coords) |
| 2 | **One recommendation per team/practice date** | `schema.sql:93-100` (UNIQUE constraint); `recommendations.repo.js:21-28` (upsert); `recommendation.service.js:88-93,127-137` (re-read stored) |
| 3 | **Ownership enforced on mutation/read path** | `teams.service.js:66-83` (authorizeTeamAccess); all routes call it first; `teams.repo.js:44-49,64-77,79` (owner_id in WHERE) |
| 4 | **DB-level uniqueness prevents duplicates** | `schema.sql:93-100` (CONSTRAINT + unique index); `recommendations.repo.js:21-28` (ON CONFLICT DO NOTHING) |
| 5 | **Server-side location validation** | `validate.js:254-311` (validateLocation); `validate.js:142-161` (lat/lon ranges); `geocoding.service.js:81-94` (upstream validation) |
| 6 | **Parameterized SQL / ORM binding** | All repos use `better-sqlite3` prepared statements with `?` placeholders; `db/index.js:12-16`; verified by `tests/database.schema.test.js:30-73` |
| 7 | **Nonexistent team ≠ unauthorized team** | `teams.service.js:66-80` (findById → owner check); distinct 404/403 codes; `tests/teams.ownership.test.js:116-145` |
| 8 | **No secrets/credentials in tracked files or history** | `.gitignore:4-15`; `.env.example` non-secret; `config.js:31-47` env-only; keyless providers; `scripts/secret-scan.js` PASS |

---

## License

MIT