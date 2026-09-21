'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestContext, teamPayload } = require('./helpers/test-app');
const recommendationsRepo = require('../src/db/repositories/recommendations.repo');
const { todayInTeamTimeZone } = require('../src/services/recommendation.service');

/**
 * CHECK 1 (server-side forecast), CHECK 2 (one row per team + date) and
 * CHECK 4 (the database enforces that uniqueness, including under a race).
 */
test('recommendation generation and persistence', async (t) => {
  const context = await createTestContext();
  t.after(() => context.close());

  const coach = context.createClient();
  await coach.register({ email: 'persist@example.com' });
  const team = (await coach.post('/teams', teamPayload())).body.team;
  const practiceDate = todayInTeamTimeZone(team);

  await t.test('the recommendation is stored against the team and the practice date', async () => {
    const response = await coach.post(`/teams/${team.id}/recommendation`, {});
    assert.equal(response.status, 201);
    assert.equal(response.body.created, true);
    assert.equal(response.body.practiceDate, practiceDate);

    const row = context.db
      .prepare('SELECT * FROM recommendations WHERE team_id = ? AND practice_date = ?')
      .get(team.id, practiceDate);

    assert.ok(row, 'a row exists keyed by (team_id, practice_date)');
    assert.equal(row.team_id, team.id);
    assert.equal(row.practice_date, practiceDate);
    assert.equal(row.practice_time, team.practiceTime);
    assert.equal(row.weather_provider, 'fake-weather');
    assert.match(row.note, /cleats/);
    // The weather snapshot is stored next to the note so it can be re-served.
    assert.equal(JSON.parse(row.forecast_json).temperatureC, 14.5);
  });

  await t.test('the stored note reflects exactly what the backend fetched', async () => {
    const stored = await coach.get(`/teams/${team.id}/recommendation`);
    assert.equal(stored.status, 200);
    assert.equal(stored.body.recommendation.weather.temperatureC, 14.5);
    assert.equal(stored.body.recommendation.weatherProvider, 'fake-weather');
    // 14.5C, 65% rain, 31 km/h -> all three signals in the wording.
    assert.match(stored.body.recommendation.note, /light jacket/);
    assert.match(stored.body.recommendation.note, /rain jacket/);
    assert.match(stored.body.recommendation.note, /windbreaker/);
    assert.ok(stored.body.recommendation.reasoning.length >= 4);
  });

  await t.test('re-running does not insert a second row or re-call the weather API', async () => {
    const weatherCallsBefore = context.weatherService.callCount();

    const rerun = await coach.post(`/teams/${team.id}/recommendation`, {});
    assert.equal(rerun.status, 200, '200 when an existing row is returned, not re-created');
    assert.equal(rerun.body.created, false);
    assert.equal(rerun.body.reused, true);

    assert.equal(context.weatherService.callCount(), weatherCallsBefore);
    assert.equal(recommendationsRepo.countByTeamAndDate(context.db, team.id, practiceDate), 1);

    // Reading back is also storage-only.
    await coach.get(`/teams/${team.id}/recommendation`);
    await coach.get(`/teams/${team.id}`);
    assert.equal(context.weatherService.callCount(), weatherCallsBefore);
  });

  await t.test('the note for a date cannot change once it has been stored', async () => {
    const first = await coach.get(`/teams/${team.id}/recommendation`);

    // Even if the forecast changes, the stored call for today stays put.
    const second = await coach.post(`/teams/${team.id}/recommendation`, {});
    assert.equal(second.body.recommendation.id, first.body.recommendation.id);
    assert.equal(second.body.recommendation.note, first.body.recommendation.note);
  });

  await t.test('a different practice date gets its own row', async () => {
    const tomorrow = new Date(`${practiceDate}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowIso = tomorrow.toISOString().slice(0, 10);

    const response = await coach.post(`/teams/${team.id}/recommendation`, { date: tomorrowIso });
    assert.equal(response.status, 201);
    assert.equal(response.body.practiceDate, tomorrowIso);
    assert.equal(recommendationsRepo.countByTeamAndDate(context.db, team.id, tomorrowIso), 1);
    assert.equal(recommendationsRepo.countByTeamAndDate(context.db, team.id, practiceDate), 1);

    const history = await coach.get(`/teams/${team.id}/recommendations`);
    assert.equal(history.body.count, 2);
  });

  await t.test('concurrent requests converge on exactly one persisted row', async () => {
    const team2 = (await coach.post('/teams', teamPayload({ name: 'Race FC' }))).body.team;

    // Eight simultaneous requests for the same team and date. Whichever one the
    // database accepts, every caller must end up with the same stored row.
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => coach.post(`/teams/${team2.id}/recommendation`, {})),
    );

    for (const response of responses) {
      assert.ok([200, 201].includes(response.status), `unexpected status ${response.status}`);
    }

    const ids = new Set(responses.map((response) => response.body.recommendation.id));
    assert.equal(ids.size, 1, 'every concurrent caller received the same recommendation id');
    assert.equal(
      responses.filter((response) => response.body.created).length,
      1,
      'exactly one caller created the row',
    );
    assert.equal(
      recommendationsRepo.countByTeamAndDate(context.db, team2.id, practiceDate),
      1,
      'the database holds exactly one row for this team and date',
    );
  });

  await t.test('the database itself refuses a duplicate (team_id, practice_date)', () => {
    // Bypass the application entirely: a raw INSERT for an existing pair must
    // fail on the UNIQUE constraint declared in schema.sql.
    const existing = context.db
      .prepare('SELECT team_id, practice_date FROM recommendations LIMIT 1')
      .get();

    assert.throws(
      () =>
        context.db
          .prepare(
            `INSERT INTO recommendations (
               team_id, practice_date, practice_time, temperature_c,
               precipitation_probability, precipitation_mm, wind_speed_kph, weather_code,
               weather_provider, weather_fetched_at, forecast_json, note, reasoning_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            existing.team_id,
            existing.practice_date,
            '17:30',
            20,
            0,
            0,
            0,
            0,
            'raw',
            '2026-01-01T00:00:00.000Z',
            '{}',
            'duplicate',
            '[]',
            '2026-01-01T00:00:00.000Z',
          ),
      (error) => error.code === 'SQLITE_CONSTRAINT_UNIQUE',
      'the UNIQUE constraint must reject the duplicate at the database level',
    );
  });

  await t.test('the insert path is an upsert, so a losing race is not an error', () => {
    const existing = context.db
      .prepare('SELECT team_id, practice_date FROM recommendations LIMIT 1')
      .get();

    const changes = recommendationsRepo.insertIfAbsent(context.db, {
      teamId: existing.team_id,
      practiceDate: existing.practice_date,
      practiceTime: '17:30',
      temperatureC: 1,
      precipitationProbability: 1,
      precipitationMm: 1,
      windSpeedKph: 1,
      weatherCode: 1,
      weatherProvider: 'test',
      weatherFetchedAt: '2026-01-01T00:00:00.000Z',
      weather: {},
      note: 'should not win',
      reasoning: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(changes, 0, 'ON CONFLICT DO NOTHING reports zero changed rows');
    assert.equal(recommendationsRepo.countByTeamAndDate(context.db, existing.team_id, existing.practice_date), 1);
  });

  await t.test('a client-supplied forecast is rejected outright', async () => {
    const team3 = (await coach.post('/teams', teamPayload({ name: 'No Fake Weather' }))).body.team;
    const weatherCallsBefore = context.weatherService.callCount();

    // Exactly the payload shape the challenge calls out as wrong.
    const fake = await coach.post(`/teams/${team3.id}/recommendation`, {
      temperature: 30,
      rain: false,
    });
    assert.equal(fake.status, 400);
    assert.equal(fake.body.error.details[0].issue, 'client_supplied_forecast');

    // Other spellings of the same attempt are caught too.
    for (const payload of [
      { temperatureC: 30 },
      { weather: { temperatureC: 30 } },
      { forecast: { temperature: 30 } },
      { windSpeedKph: 0, precipitationProbability: 0 },
      { note: 'cleats + shorts' },
      { outfit: 'shorts' },
    ]) {
      const response = await coach.post(`/teams/${team3.id}/recommendation`, payload);
      assert.equal(response.status, 400, `${JSON.stringify(payload)} must be rejected`);
    }

    assert.equal(context.weatherService.callCount(), weatherCallsBefore, 'no weather call was made');
    assert.equal(recommendationsRepo.countByTeamAndDate(context.db, team3.id, practiceDate), 0);
  });

  await t.test('ownership still takes precedence over body validation', async () => {
    const intruder = context.createClient();
    await intruder.register({ email: 'intruder@example.com' });

    // Nonexistent team: 404 even with a forecast-shaped body.
    const missing = await intruder.post('/teams/424242/recommendation', { temperature: 30 });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'TEAM_NOT_FOUND');

    // Somebody else's team: 403 even with a forecast-shaped body.
    const forbidden = await intruder.post(`/teams/${team.id}/recommendation`, { temperature: 30 });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'TEAM_FORBIDDEN');
  });

  await t.test('the practice date is validated server-side', async () => {
    const team4 = (await coach.post('/teams', teamPayload({ name: 'Date Checks' }))).body.team;
    const weatherCallsBefore = context.weatherService.callCount();

    for (const date of ['not-a-date', '2026-02-30', '2026-13-01', '', 'tomorrow']) {
      const response = await coach.post(`/teams/${team4.id}/recommendation`, { date });
      assert.equal(response.status, 400, `date "${date}" must be rejected`);
    }

    // Too far ahead for a forecast to exist: rejected before any network call.
    const farFuture = await coach.post(`/teams/${team4.id}/recommendation`, { date: '2030-01-01' });
    assert.equal(farFuture.status, 400);
    assert.equal(farFuture.body.error.details[0].issue, 'out_of_range');

    const badQueryDate = await coach.get(`/teams/${team4.id}/recommendation?date=oops`);
    assert.equal(badQueryDate.status, 400);
    assert.equal(
      context.weatherService.callCount(),
      weatherCallsBefore,
      'no upstream call for an invalid date',
    );
  });

  await t.test('a weather provider outage is a 502, not a stored fake note', async () => {
    const { badGateway, ERROR_CODES } = require('../src/lib/errors');

    const failing = await createTestContext({
      weatherService: {
        provider: 'broken-weather',
        async getPracticeForecast() {
          // The real provider does exactly this when Open-Meteo is unreachable.
          throw badGateway(ERROR_CODES.WEATHER_UNAVAILABLE, 'The weather provider could not be reached.');
        },
      },
    });
    t.after(() => failing.close());

    const client = failing.createClient();
    await client.register({ email: 'outage@example.com' });
    const teamWithOutage = (await client.post('/teams', teamPayload({ name: 'Outage FC' }))).body.team;

    const response = await client.post(`/teams/${teamWithOutage.id}/recommendation`, {});
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'WEATHER_UNAVAILABLE');
    assert.equal(
      failing.db.prepare('SELECT COUNT(*) AS total FROM recommendations').get().total,
      0,
      'nothing is persisted when the forecast cannot be fetched',
    );
  });

  await t.test('reading a recommendation that was never generated is a distinct 404', async () => {
    const team5 = (await coach.post('/teams', teamPayload({ name: 'No Notes Yet' }))).body.team;

    const response = await coach.get(`/teams/${team5.id}/recommendation`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'RECOMMENDATION_NOT_FOUND');

    // Distinguishable from a missing team, which is also a 404 but a different code.
    const missingTeam = await coach.get('/teams/777777/recommendation');
    assert.equal(missingTeam.status, 404);
    assert.equal(missingTeam.body.error.code, 'TEAM_NOT_FOUND');
    assert.notEqual(response.body.error.code, missingTeam.body.error.code);
  });
});
