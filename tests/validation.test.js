'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateLocation,
  validateLatitude,
  validateLongitude,
  validatePracticeDays,
  validatePracticeTime,
  validatePracticeDate,
  validateTeamName,
  validateEmail,
  validatePassword,
  validateTimeZone,
  validateId,
} = require('../src/lib/validate');

/** Assert that `fn` throws an AppError with the given status. */
function assertRejects(fn, status, label) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.status, status, `${label}: expected HTTP ${status}, got ${error.status}`);
    assert.equal(error.name, 'AppError', `${label}: expected an AppError`);
    return error;
  }
  assert.fail(`${label}: expected a ${status} validation error, but nothing was thrown`);
}

test('location validation rejects a missing, empty or blank location', () => {
  assertRejects(() => validateLocation({}), 400, 'no location field');
  assertRejects(() => validateLocation(undefined), 400, 'undefined body');
  assertRejects(() => validateLocation({ location: '' }), 400, 'empty string');
  assertRejects(() => validateLocation({ location: '   ' }), 400, 'whitespace only');
  assertRejects(() => validateLocation({ location: null }), 400, 'null');
  assertRejects(() => validateLocation({ location: { place: '' } }), 400, 'empty place object');
});

test('location validation rejects malformed place names', () => {
  assertRejects(() => validateLocation({ location: 'A'.repeat(201) }), 400, 'over-long place');
  assertRejects(() => validateLocation({ location: 'Austin; DROP TABLE teams' }), 400, 'SQL punctuation');
  assertRejects(() => validateLocation({ location: '<script>alert(1)</script>' }), 400, 'markup');
  assertRejects(() => validateLocation({ location: 'Austin\u0000TX' }), 400, 'control character');
  assertRejects(() => validateLocation({ location: 42 }), 400, 'a number where a place is expected');
});

test('location validation accepts real-world place names', () => {
  assert.equal(validateLocation({ location: 'Austin' }).type, 'place');
  assert.equal(validateLocation({ location: 'Cedar Park, Texas' }).query, 'Cedar Park, Texas');
  assert.equal(validateLocation({ location: "St. John's" }).query, "St. John's");
  assert.equal(validateLocation({ location: 'São Paulo' }).query, 'São Paulo');
  assert.equal(validateLocation({ location: { place: 'Boston' } }).query, 'Boston');
});

test('coordinate validation enforces the documented ranges', () => {
  assert.equal(validateLatitude(0), 0);
  assert.equal(validateLatitude(-90), -90);
  assert.equal(validateLatitude(90), 90);
  assert.equal(validateLatitude('30.5'), 30.5);
  assertRejects(() => validateLatitude(90.0001), 400, 'latitude above 90');
  assertRejects(() => validateLatitude(-90.0001), 400, 'latitude below -90');
  assertRejects(() => validateLatitude('not-a-number'), 400, 'non-numeric latitude');
  assertRejects(() => validateLatitude(Number.NaN), 400, 'NaN latitude');
  assertRejects(() => validateLatitude(Number.POSITIVE_INFINITY), 400, 'infinite latitude');

  assert.equal(validateLongitude(-180), -180);
  assert.equal(validateLongitude(180), 180);
  assertRejects(() => validateLongitude(180.0001), 400, 'longitude above 180');
  assertRejects(() => validateLongitude(-180.0001), 400, 'longitude below -180');
  assertRejects(() => validateLongitude(undefined), 400, 'missing longitude');
});

test('coordinate locations report which half of the pair is wrong', () => {
  const latitudeError = assertRejects(
    () => validateLocation({ latitude: 120, longitude: 10 }),
    400,
    'latitude out of range',
  );
  assert.equal(latitudeError.details[0].field, 'latitude');

  const longitudeError = assertRejects(
    () => validateLocation({ latitude: 10, longitude: 900 }),
    400,
    'longitude out of range',
  );
  assert.equal(longitudeError.details[0].field, 'longitude');

  assert.deepEqual(validateLocation({ latitude: '30.5052', longitude: '-97.8203' }), {
    type: 'coordinates',
    latitude: 30.5052,
    longitude: -97.8203,
    timezone: undefined,
  });
});

test('schedule validation rejects malformed practice days and times', () => {
  assert.deepEqual(validatePracticeDays([3, 1, 3]), [1, 3], 'deduplicated and sorted');
  assertRejects(() => validatePracticeDays([]), 400, 'empty day list');
  assertRejects(() => validatePracticeDays('Mon'), 400, 'not an array');
  assertRejects(() => validatePracticeDays([7]), 400, 'day 7 does not exist');
  assertRejects(() => validatePracticeDays([-1]), 400, 'negative day');
  assertRejects(() => validatePracticeDays([1.5]), 400, 'fractional day');

  assert.equal(validatePracticeTime('00:00'), '00:00');
  assert.equal(validatePracticeTime('23:59'), '23:59');
  assertRejects(() => validatePracticeTime('24:00'), 400, 'hour 24');
  assertRejects(() => validatePracticeTime('17:60'), 400, 'minute 60');
  assertRejects(() => validatePracticeTime('5pm'), 400, '12-hour form');
  assertRejects(() => validatePracticeTime(''), 400, 'empty time');
});

test('date validation rejects malformed and impossible dates', () => {
  assert.equal(validatePracticeDate('2026-09-21'), '2026-09-21');
  assertRejects(() => validatePracticeDate('2026-02-30'), 400, 'February 30th');
  assertRejects(() => validatePracticeDate('2026-13-01'), 400, 'month 13');
  assertRejects(() => validatePracticeDate('21-09-2026'), 400, 'non-ISO order');
  assertRejects(() => validatePracticeDate('today'), 400, 'not a date');
  assertRejects(() => validatePracticeDate(''), 400, 'empty date');
});

test('team name, email and password rules', () => {
  assert.equal(validateTeamName('  U10 Thunder  '), 'U10 Thunder');
  assertRejects(() => validateTeamName(''), 400, 'empty name');
  assertRejects(() => validateTeamName('   '), 400, 'blank name');
  assertRejects(() => validateTeamName(undefined), 400, 'missing name');
  assertRejects(() => validateTeamName('a'.repeat(81)), 400, 'over-long name');
  assertRejects(() => validateTeamName('bad\u0001name'), 400, 'control character in name');

  assert.equal(validateEmail('  Priya@Example.COM '), 'priya@example.com');
  assertRejects(() => validateEmail('not-an-email'), 400, 'malformed email');
  assertRejects(() => validateEmail('a@b'), 400, 'no top-level domain');
  assertRejects(() => validateEmail(''), 400, 'empty email');

  assert.equal(validatePassword('longenough'), 'longenough');
  assertRejects(() => validatePassword('short'), 400, 'too short');
  assertRejects(() => validatePassword(undefined), 400, 'missing password');
  assertRejects(() => validatePassword('a'.repeat(201)), 400, 'too long');
});

test('timezone and id validation', () => {
  assert.equal(validateTimeZone('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(validateTimeZone(undefined), undefined);
  assert.equal(validateTimeZone(''), undefined);
  assertRejects(() => validateTimeZone('Mars/Olympus_Mons'), 400, 'unknown timezone');

  assert.equal(validateId('12'), 12);
  assert.equal(validateId(7), 7);
  assertRejects(() => validateId('0'), 400, 'zero id');
  assertRejects(() => validateId('-5'), 400, 'negative id');
  assertRejects(() => validateId('1.5'), 400, 'fractional id');
  assertRejects(() => validateId('1 OR 1=1'), 400, 'injection-shaped id');
  assertRejects(() => validateId("1'; DROP TABLE teams; --"), 400, 'SQL in an id');
  assertRejects(() => validateId('abc'), 400, 'non-numeric id');
  assertRejects(() => validateId(undefined), 400, 'missing id');
});

test('location validation is independent of any client-side check', () => {
  // A whitespace/tab padded value satisfies HTML `required` but must still fail
  // server-side; nothing here involves a browser.
  assertRejects(() => validateLocation({ location: ' \t\n ' }), 400, 'tab/newline padded value');
  assert.equal(validateLocation({ location: 'Cedar Park, Texas' }).type, 'place');
});
