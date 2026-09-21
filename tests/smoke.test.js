'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestContext, teamPayload } = require('./helpers/test-app');

/**
 * End-to-end smoke test across the real HTTP surface: register -> create team ->
 * generate today's recommendation -> re-run -> read back, plus the ownership and
 * 404-vs-403 distinction.
 */
test('complete coach workflow', async (t) => {
  const context = await createTestContext();
  t.after(() => context.close());

  const coachA = context.createClient();
  const coachB = context.createClient();

  await t.test('a coach can register and is identified from the session cookie', async () => {
    const register = await coachA.register({ email: 'priya@example.com', displayName: 'Priya' });
    assert.equal(register.status, 201);
    assert.equal(register.body.user.email, 'priya@example.com');

    const me = await coachA.get('/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.displayName, 'Priya');
  });

  let teamA;

  await t.test('a coach can register a team with a location and schedule', async () => {
    const created = await coachA.post('/teams', teamPayload());
    assert.equal(created.status, 201);
    teamA = created.body.team;

    assert.equal(teamA.name, 'U10 Thunder');
    assert.equal(teamA.location.resolvedName, 'Austin, Texas, United States');
    assert.equal(teamA.location.latitude, 30.2672);
    assert.deepEqual(teamA.practiceDays, [1, 3]);
    assert.equal(teamA.practiceTime, '17:30');
    assert.ok(teamA.timezone.length > 0);
  });

  let firstRecommendationId;

  await t.test('the backend generates a forecast-grounded recommendation', async () => {
    const response = await coachA.post(`/teams/${teamA.id}/recommendation`, {});
    assert.equal(response.status, 201);
    assert.equal(response.body.created, true);
    assert.equal(response.body.reused, false);

    const { recommendation } = response.body;
    firstRecommendationId = recommendation.id;

    assert.match(recommendation.note, /cleats/);
    // 14.5C / 65% rain / 31 km/h wind -> jacket, rain gear and a windbreaker.
    assert.match(recommendation.note, /light jacket/);
    assert.match(recommendation.note, /rain jacket/);
    assert.match(recommendation.note, /windbreaker/);
    assert.equal(recommendation.weatherProvider, 'fake-weather');
    assert.equal(recommendation.weather.temperatureC, 14.5);
  });

  await t.test('re-running re-uses the stored note instead of creating a second one', async () => {
    const before = context.weatherService.callCount();

    const second = await coachA.post(`/teams/${teamA.id}/recommendation`, {});
    assert.equal(second.status, 200);
    assert.equal(second.body.created, false);
    assert.equal(second.body.reused, true);
    assert.equal(second.body.recommendation.id, firstRecommendationId);
    // No second weather call and no second row.
    assert.equal(context.weatherService.callCount(), before);
    assert.equal(
      context.db
        .prepare('SELECT COUNT(*) AS total FROM recommendations WHERE team_id = ?')
        .get(teamA.id).total,
      1,
    );
  });

  await t.test('the stored recommendation is readable without touching the weather API', async () => {
    const before = context.weatherService.callCount();

    const stored = await coachA.get(`/teams/${teamA.id}/recommendation`);
    assert.equal(stored.status, 200);
    assert.equal(stored.body.recommendation.id, firstRecommendationId);
    assert.equal(context.weatherService.callCount(), before);
  });

  await t.test('a coach only sees their own teams', async () => {
    await coachB.register({ email: 'sam@example.com' });

    const coachBTeams = await coachB.get('/teams');
    assert.equal(coachBTeams.status, 200);
    assert.deepEqual(coachBTeams.body.teams, []);

    const coachATeams = await coachA.get('/teams');
    assert.equal(coachATeams.body.count, 1);
  });

  await t.test('another coach is forbidden (403) and a missing team is not found (404)', async () => {
    const otherCoach = await coachB.get(`/teams/${teamA.id}`);
    assert.equal(otherCoach.status, 403);
    assert.equal(otherCoach.body.error.code, 'TEAM_FORBIDDEN');
    assert.equal(JSON.stringify(otherCoach.body).includes('U10 Thunder'), false);

    const missing = await coachB.get('/teams/999999');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'TEAM_NOT_FOUND');
  });

  await t.test('unauthenticated requests are rejected', async () => {
    const anonymous = context.createClient();
    const response = await anonymous.get('/teams');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHENTICATED');
  });
});
