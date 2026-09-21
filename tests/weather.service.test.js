'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregatePracticeWindow,
  createOpenMeteoWeatherService,
  weatherCodeSeverity,
  HOURLY_VARIABLES,
} = require('../src/services/weather.service');
const { createOpenMeteoGeocodingService } = require('../src/services/geocoding.service');

/** Raw Open-Meteo-shaped hourly block for one date. */
function hourlyFixture(overrides = {}) {
  const times = [];
  for (let hour = 0; hour < 24; hour += 1) {
    times.push(`2026-09-21T${String(hour).padStart(2, '0')}:00`);
  }
  const filled = (value) => times.map(() => value);
  return {
    time: times,
    temperature_2m: times.map((_, index) => 10 + index),
    precipitation_probability: times.map((_, index) => index),
    precipitation: filled(0.1),
    wind_speed_10m: times.map((_, index) => index * 2),
    weather_code: filled(0),
    is_day: times.map((_, index) => (index >= 6 && index < 19 ? 1 : 0)),
    ...overrides,
  };
}

test('weather aggregation: picks the hours inside the practice window only', () => {
  const result = aggregatePracticeWindow(hourlyFixture(), {
    practiceDate: '2026-09-21',
    practiceTime: '17:30',
    durationMinutes: 90,
  });

  // 17:00 and 18:00 are the hours within 17:30 -> 19:00.
  assert.equal(result.sampleCount, 2);
  assert.deepEqual(
    result.samples.map((sample) => sample.time),
    ['2026-09-21T17:00', '2026-09-21T18:00'],
  );
  assert.equal(result.windowStart, '2026-09-21T17:30');
  assert.equal(result.windowEnd, '2026-09-21T19:00');
});

test('weather aggregation: a practice that starts mid-hour still sees that hour', () => {
  // Regression guard: a 17:30 practice is inside the 17:00-18:00 forecast row,
  // and the window ends exactly on the hour so 19:00 must NOT be pulled in.
  const result = aggregatePracticeWindow(hourlyFixture(), {
    practiceDate: '2026-09-21',
    practiceTime: '17:30',
    durationMinutes: 90,
  });

  assert.deepEqual(
    result.samples.map((sample) => sample.time),
    ['2026-09-21T17:00', '2026-09-21T18:00'],
  );

  const onTheHour = aggregatePracticeWindow(hourlyFixture(), {
    practiceDate: '2026-09-21',
    practiceTime: '17:00',
    durationMinutes: 60,
  });
  assert.deepEqual(
    onTheHour.samples.map((sample) => sample.time),
    ['2026-09-21T17:00'],
    'a 60 minute window starting on the hour covers exactly one row',
  );
});

test('weather aggregation: peak wind and max rain chance drive the numbers', () => {
  const result = aggregatePracticeWindow(hourlyFixture(), {
    practiceDate: '2026-09-21',
    practiceTime: '17:30',
    durationMinutes: 90,
  });

  // temperature_2m = 10 + hour -> 27 and 28 for hours 17 and 18 -> mean 27.5
  assert.equal(result.temperatureC, 27.5);
  assert.equal(result.precipitationProbability, 18, 'max of 17% and 18%');
  assert.equal(result.precipitationMm, 0.2, 'sum of 0.1 + 0.1');
  assert.equal(result.windSpeedKph, 36, 'max of 34 and 36');
});

test('weather aggregation: the worst weather code in the window wins', () => {
  const codes = new Array(24).fill(0);
  codes[17] = 61; // rain at 17:00
  codes[18] = 3; // overcast at 18:00

  const result = aggregatePracticeWindow(hourlyFixture({ weather_code: codes }), {
    practiceDate: '2026-09-21',
    practiceTime: '17:30',
    durationMinutes: 90,
  });

  assert.equal(result.weatherCode, 61);
  assert.ok(weatherCodeSeverity(95) > weatherCodeSeverity(3));
  assert.ok(weatherCodeSeverity(61) > weatherCodeSeverity(2));
});

test('weather aggregation: ignores other dates and reports missing data loudly', () => {
  // The fixture only contains hours for 2026-09-21, so another date has no data
  // and must surface as a 502 rather than silently producing a fake forecast.
  assert.throws(
    () =>
      aggregatePracticeWindow(hourlyFixture(), {
        practiceDate: '2026-09-22',
        practiceTime: '17:30',
        durationMinutes: 90,
      }),
    (error) => error.status === 502 && error.code === 'WEATHER_UNAVAILABLE',
  );

  assert.throws(
    () =>
      aggregatePracticeWindow(
        {},
        { practiceDate: '2026-09-21', practiceTime: '17:30', durationMinutes: 90 },
      ),
    (error) => error.status === 502,
  );
});

test('weather aggregation is a pure function of its input', () => {
  const params = { practiceDate: '2026-09-21', practiceTime: '17:30', durationMinutes: 90 };
  const first = aggregatePracticeWindow(hourlyFixture(), params);
  const second = aggregatePracticeWindow(hourlyFixture(), params);
  assert.deepEqual(first, second);
});

test('weather provider: requests the forecast from the backend for the right coordinates', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        latitude: 30.2672,
        longitude: -97.7431,
        elevation: 149,
        timezone: 'America/Chicago',
        utc_offset_seconds: -18000,
        hourly: hourlyFixture(),
      }),
    };
  };

  const service = createOpenMeteoWeatherService({
    fetchImpl,
    baseUrl: 'https://api.open-meteo.com/v1',
    now: () => new Date('2026-09-21T12:00:00.000Z'),
  });

  const forecast = await service.getPracticeForecast({
    latitude: 30.2672,
    longitude: -97.7431,
    practiceDate: '2026-09-21',
    practiceTime: '17:30',
    durationMinutes: 90,
  });

  assert.equal(requests.length, 1, 'exactly one outbound request');
  const url = new URL(requests[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('latitude'), '30.2672');
  assert.equal(url.searchParams.get('longitude'), '-97.7431');
  assert.equal(url.searchParams.get('start_date'), '2026-09-21');
  assert.equal(url.searchParams.get('end_date'), '2026-09-21');
  assert.equal(url.searchParams.get('timezone'), 'auto');
  for (const variable of HOURLY_VARIABLES) {
    assert.ok(url.searchParams.get('hourly').includes(variable), `requested ${variable}`);
  }

  assert.equal(forecast.provider, 'open-meteo');
  assert.equal(forecast.fetchedAt, '2026-09-21T12:00:00.000Z');
  assert.equal(forecast.timezone, 'America/Chicago');
  assert.equal(forecast.temperatureC, 27.5);
  assert.equal(forecast.windSpeedKph, 36);
  assert.equal(forecast.precipitationProbability, 18);
});

test('weather provider: coerces upstream failures into a 502 instead of crashing', async (t) => {
  await t.test('HTTP error from the provider', async () => {
    const service = createOpenMeteoWeatherService({
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    await assert.rejects(
      () =>
        service.getPracticeForecast({
          latitude: 1,
          longitude: 2,
          practiceDate: '2026-09-21',
          practiceTime: '17:30',
          durationMinutes: 90,
        }),
      (error) => error.status === 502 && error.code === 'WEATHER_UNAVAILABLE',
    );
  });

  await t.test('network failure', async () => {
    const service = createOpenMeteoWeatherService({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await assert.rejects(
      () =>
        service.getPracticeForecast({
          latitude: 1,
          longitude: 2,
          practiceDate: '2026-09-21',
          practiceTime: '17:30',
          durationMinutes: 90,
        }),
      (error) => error.status === 502,
    );
  });

  await t.test('a structurally wrong payload', async () => {
    const service = createOpenMeteoWeatherService({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nothing: true }) }),
    });
    await assert.rejects(
      () =>
        service.getPracticeForecast({
          latitude: 1,
          longitude: 2,
          practiceDate: '2026-09-21',
          practiceTime: '17:30',
          durationMinutes: 90,
        }),
      (error) => error.status === 502,
    );
  });

  await t.test('an aborted request (timeout) is reported as unavailable', async () => {
    const service = createOpenMeteoWeatherService({
      fetchImpl: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      timeoutMs: 20,
    });
    await assert.rejects(
      () =>
        service.getPracticeForecast({
          latitude: 1,
          longitude: 2,
          practiceDate: '2026-09-21',
          practiceTime: '17:30',
          durationMinutes: 90,
        }),
      (error) => error.status === 502,
    );
  });
});

test('weather provider: resolves a coordinate timezone via the provider', async () => {
  const fetched = [];
  const service = createOpenMeteoWeatherService({
    fetchImpl: async (url) => {
      fetched.push(String(url));
      return { ok: true, status: 200, json: async () => ({ timezone: 'America/New_York' }) };
    },
  });

  assert.equal(await service.getTimeZoneForCoordinates({ latitude: 40, longitude: -74 }), 'America/New_York');
  assert.match(fetched[0], /timezone=auto/);
});

test('geocoding provider: resolves a place to coordinates and a timezone (server-side)', async () => {
  const requests = [];
  const service = createOpenMeteoGeocodingService({
    fetchImpl: async (url) => {
      requests.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              name: 'Cedar Park',
              latitude: 30.5052,
              longitude: -97.8203,
              admin1: 'Texas',
              country: 'United States',
              timezone: 'America/Chicago',
            },
          ],
        }),
      };
    },
  });

  const resolved = await service.resolvePlace('Cedar Park');
  assert.equal(resolved.latitude, 30.5052);
  assert.equal(resolved.longitude, -97.8203);
  assert.equal(resolved.timezone, 'America/Chicago');
  assert.equal(resolved.resolvedName, 'Cedar Park, Texas, United States');

  const url = new URL(requests[0]);
  assert.equal(url.searchParams.get('name'), 'Cedar Park');
  assert.equal(url.searchParams.get('count'), '1');
});

test('geocoding provider: an unresolvable place is a 422, never a guessed coordinate', async (t) => {
  const service = createOpenMeteoGeocodingService({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }),
  });

  await t.test('invented place name', async () => {
    await assert.rejects(
      () => service.resolvePlace('Definitelynotarealplacexyz'),
      (error) => error.status === 422 && error.code === 'LOCATION_UNRESOLVED',
    );
  });

  await t.test('blank and malformed input is rejected before the network call', async () => {
    let called = false;
    const spy = createOpenMeteoGeocodingService({
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      },
    });

    await assert.rejects(() => spy.resolvePlace('   '), (error) => error.status === 422);
    await assert.rejects(() => spy.resolvePlace('a'.repeat(300)), (error) => error.status === 422);
    await assert.rejects(() => spy.resolvePlace('x; DROP TABLE users'), (error) => error.status === 422);
    assert.equal(called, false, 'invalid input must not reach the provider');
  });

  await t.test('an out-of-range upstream answer is not trusted', async () => {
    const rogue = createOpenMeteoGeocodingService({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ name: 'Nowhere', latitude: 999, longitude: 999, timezone: 'UTC' }] }),
      }),
    });
    await assert.rejects(() => rogue.resolvePlace('Nowhere'), (error) => error.status === 502);
  });

  await t.test('a provider outage is a 502', async () => {
    const down = createOpenMeteoGeocodingService({
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    await assert.rejects(
      () => down.resolvePlace('Austin'),
      (error) => error.status === 502 && error.code === 'GEOCODING_FAILED',
    );
  });
});
