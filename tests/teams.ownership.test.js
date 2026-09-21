'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestContext, teamPayload } = require('./helpers/test-app');

/**
 * CHECK 3 (ownership on the read/write path) and CHECK 7 (404 vs 403).
 *
 * Two coaches each own a team; every team-scoped route is exercised from the
 * "wrong" coach's session, and the database is inspected afterwards to prove
 * that nothing was read, changed or deleted.
 */
test('team ownership enforcement', async (t) => {
  const context = await createTestContext();
  t.after(() => context.close());

  const coachA = context.createClient();
  const coachB = context.createClient();

  await coachA.register({ email: 'coach.a@example.com', displayName: 'Coach A' });
  await coachB.register({ email: 'coach.b@example.com', displayName: 'Coach B' });

  const teamA = (await coachA.post('/teams', teamPayload({ name: 'Team A' }))).body.team;
  const teamB = (
    await coachB.post('/teams', teamPayload({ name: 'Team B', location: 'Boston' }))
  ).body.team;

  await t.test('each coach is assigned as the owner of their own team', () => {
    assert.equal(teamA.name, 'Team A');
    assert.equal(teamB.name, 'Team B');

    const rows = context.db.prepare('SELECT id, owner_id FROM teams').all();
    const owners = new Map(rows.map((row) => [row.id, row.owner_id]));
    assert.equal(owners.get(teamA.id), context.db.prepare('SELECT id FROM users WHERE email = ?').get('coach.a@example.com').id);
    assert.equal(owners.get(teamB.id), context.db.prepare('SELECT id FROM users WHERE email = ?').get('coach.b@example.com').id);
    assert.notEqual(owners.get(teamA.id), owners.get(teamB.id));
  });

  await t.test('the team list is scoped to the owner', async () => {
    const listA = await coachA.get('/teams');
    const listB = await coachB.get('/teams');

    assert.equal(listA.body.count, 1);
    assert.equal(listA.body.teams[0].name, 'Team A');
    assert.equal(listB.body.count, 1);
    assert.equal(listB.body.teams[0].name, 'Team B');
  });

  await t.test("reading another coach's team is 403 and leaks nothing about it", async () => {
    const response = await coachA.get(`/teams/${teamB.id}`);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'TEAM_FORBIDDEN');
    const serialised = JSON.stringify(response.body);
    assert.equal(serialised.includes('Team B'), false, 'the team name must not leak');
    assert.equal(serialised.includes('Boston'), false, 'the location must not leak');
    assert.equal(serialised.includes(String(teamB.id)), false, 'no team payload at all');
  });

  await t.test("updating another coach's team is 403 and changes nothing", async () => {
    const before = context.db.prepare('SELECT * FROM teams WHERE id = ?').get(teamB.id);

    const patch = await coachA.patch(`/teams/${teamB.id}`, { name: 'Hijacked' });
    const put = await coachA.put(`/teams/${teamB.id}`, { name: 'Hijacked too' });

    assert.equal(patch.status, 403);
    assert.equal(put.status, 403);
    assert.equal(patch.body.error.code, 'TEAM_FORBIDDEN');

    const after = context.db.prepare('SELECT * FROM teams WHERE id = ?').get(teamB.id);
    assert.deepEqual(after, before, 'the row must be byte-for-byte unchanged');
  });

  await t.test("deleting another coach's team is 403 and the team survives", async () => {
    const response = await coachA.del(`/teams/${teamB.id}`);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'TEAM_FORBIDDEN');
    assert.equal(
      context.db.prepare('SELECT COUNT(*) AS total FROM teams WHERE id = ?').get(teamB.id).total,
      1,
    );
    // The real owner still sees it.
    assert.equal((await coachB.get(`/teams/${teamB.id}`)).status, 200);
  });

  await t.test("generating a recommendation for another coach's team is 403 and writes nothing", async () => {
    const before = context.db.prepare('SELECT COUNT(*) AS total FROM recommendations').get().total;

    const response = await coachA.post(`/teams/${teamB.id}/recommendation`, {});

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'TEAM_FORBIDDEN');
    assert.equal(
      context.db.prepare('SELECT COUNT(*) AS total FROM recommendations').get().total,
      before,
      'no recommendation row may be created for another coach',
    );
    assert.equal(context.weatherService.callCount(), 0, 'no weather call for a forbidden team');
  });

  await t.test("reading another coach's recommendation is 403", async () => {
    // Coach B has a stored note of their own; coach A still cannot read it.
    await coachB.post(`/teams/${teamB.id}/recommendation`, {});

    const single = await coachA.get(`/teams/${teamB.id}/recommendation`);
    const history = await coachA.get(`/teams/${teamB.id}/recommendations`);

    assert.equal(single.status, 403);
    assert.equal(single.body.error.code, 'TEAM_FORBIDDEN');
    assert.equal(history.status, 403);
  });

  await t.test('a nonexistent team is 404 and is distinguishable from 403', async () => {
    const missing = await coachA.get('/teams/999999');
    const forbidden = await coachA.get(`/teams/${teamB.id}`);

    assert.equal(missing.status, 404);
    assert.equal(forbidden.status, 403);
    assert.notEqual(missing.status, forbidden.status, 'statuses must differ');
    assert.notEqual(missing.body.error.code, forbidden.body.error.code);
    assert.equal(missing.body.error.code, 'TEAM_NOT_FOUND');
    assert.equal(forbidden.body.error.code, 'TEAM_FORBIDDEN');
    assert.notDeepEqual(missing.body, forbidden.body);
  });

  await t.test('the distinction holds on every team-scoped route', async () => {
    const missing = 987654321;
    const cases = [
      ['GET', `/teams/${missing}`],
      ['PATCH', `/teams/${missing}`],
      ['DELETE', `/teams/${missing}`],
      ['POST', `/teams/${missing}/recommendation`],
      ['GET', `/teams/${missing}/recommendation`],
      ['GET', `/teams/${missing}/recommendations`],
    ];

    for (const [method, path] of cases) {
      const response = await coachA.request(method, path, method === 'GET' ? {} : { body: {} });
      assert.equal(response.status, 404, `${method} ${path} should be 404`);
      assert.equal(response.body.error.code, 'TEAM_NOT_FOUND');
    }
  });

  await t.test('a coach cannot reassign ownership by sending ownerId in the payload', async () => {
    const coachBId = context.db.prepare('SELECT id FROM users WHERE email = ?').get('coach.b@example.com').id;

    const created = await coachA.post(
      '/teams',
      teamPayload({ name: 'Sneaky', ownerId: coachBId, owner_id: coachBId }),
    );
    assert.equal(created.status, 201);

    const row = context.db.prepare('SELECT owner_id FROM teams WHERE id = ?').get(created.body.team.id);
    const coachAId = context.db.prepare('SELECT id FROM users WHERE email = ?').get('coach.a@example.com').id;
    assert.equal(row.owner_id, coachAId, 'the server assigns ownership from the session, not the body');

    // And the same on update: ownership never moves.
    const updated = await coachA.patch(`/teams/${created.body.team.id}`, {
      name: 'Renamed',
      ownerId: coachBId,
    });
    assert.equal(updated.status, 200);
    assert.equal(
      context.db.prepare('SELECT owner_id FROM teams WHERE id = ?').get(created.body.team.id).owner_id,
      coachAId,
    );

    // Coach B still cannot see it.
    assert.equal((await coachB.get(`/teams/${created.body.team.id}`)).status, 403);
  });

  await t.test('a coach can update and delete their own team', async () => {
    const updated = await coachA.patch(`/teams/${teamA.id}`, {
      name: 'Team A (renamed)',
      practiceTime: '18:15',
      practiceDays: [2, 5],
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.team.name, 'Team A (renamed)');
    assert.equal(updated.body.team.practiceTime, '18:15');
    assert.deepEqual(updated.body.team.practiceDays, [2, 5]);
    assert.deepEqual(updated.body.team.practiceDayNames, ['Tuesday', 'Friday']);

    // Give team B a stored recommendation first, to prove the cascade later.
    await coachB.post(`/teams/${teamB.id}/recommendation`, {});
    assert.ok(
      context.db.prepare('SELECT COUNT(*) AS total FROM recommendations WHERE team_id = ?').get(teamB.id)
        .total >= 1,
    );

    const deleted = await coachA.del(`/teams/${teamA.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.equal((await coachA.get(`/teams/${teamA.id}`)).status, 404);
    // Only the "Sneaky" team created earlier in this suite is left.
    const remaining = await coachA.get('/teams');
    assert.equal(remaining.body.count, 1);
    assert.equal(remaining.body.teams[0].name, 'Renamed');
  });

  await t.test("deleting a team removes that team's recommendations only", async () => {
    assert.equal(
      context.db.prepare('SELECT COUNT(*) AS total FROM recommendations WHERE team_id = ?').get(teamA.id)
        .total,
      0,
    );
    assert.ok(
      context.db.prepare('SELECT COUNT(*) AS total FROM recommendations WHERE team_id = ?').get(teamB.id)
        .total >= 1,
      "another coach's stored note is untouched",
    );
    assert.equal((await coachB.get(`/teams/${teamB.id}/recommendation`)).status, 200);
  });

  await t.test('ownership is enforced on the query itself as well as in the service', () => {
    const teamsRepo = require('../src/db/repositories/teams.repo');
    const coachBId = context.db.prepare('SELECT id FROM users WHERE email = ?').get('coach.b@example.com').id;
    const coachAId = context.db.prepare('SELECT id FROM users WHERE email = ?').get('coach.a@example.com').id;

    // The owner-scoped lookup finds it, the wrong owner's lookup does not.
    assert.ok(teamsRepo.findByIdAndOwner(context.db, teamB.id, coachBId));
    assert.equal(teamsRepo.findByIdAndOwner(context.db, teamB.id, coachAId), null);

    // A DELETE or UPDATE crafted with the wrong owner id touches zero rows.
    assert.equal(teamsRepo.deleteOwned(context.db, teamB.id, coachAId), 0);
    assert.equal(
      teamsRepo.updateOwned(
        context.db,
        teamB.id,
        coachAId,
        {
          name: 'nope',
          practiceDays: [1],
          practiceTime: '10:00',
          locationType: 'coordinates',
          locationQuery: null,
          latitude: 1,
          longitude: 1,
          resolvedName: 'x',
          timezone: 'UTC',
        },
        '2026-01-01T00:00:00.000Z',
      ),
      null,
    );
    assert.equal(
      context.db.prepare('SELECT name FROM teams WHERE id = ?').get(teamB.id).name,
      'Team B',
      'the row is untouched',
    );
  });
});
