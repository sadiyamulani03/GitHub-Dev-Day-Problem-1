'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOutfitRecommendation,
  temperatureBand,
  precipitationBand,
  windBand,
  describeWeatherCode,
  TEMPERATURE_BANDS,
  PRECIPITATION_BANDS,
  WIND_BANDS,
} = require('../src/services/outfit.engine');

/** A calm, dry baseline that tests then perturb one signal at a time. */
function base(overrides = {}) {
  return {
    temperatureC: 20,
    precipitationProbability: 0,
    precipitationMm: 0,
    windSpeedKph: 5,
    weatherCode: 0,
    isDay: true,
    ...overrides,
  };
}

test('outfit engine: every call starts with cleats', () => {
  const result = buildOutfitRecommendation(base());
  assert.equal(result.gear[0], 'cleats');
  assert.match(result.note, /^cleats/);
});

test('outfit engine: temperature bands', async (t) => {
  await t.test('freezing adds an insulated jacket, gloves and a beanie', () => {
    const { gear, note, factors } = buildOutfitRecommendation(base({ temperatureC: -3 }));
    assert.equal(factors.temperatureBand, 'freezing');
    assert.ok(gear.includes('insulated jacket'));
    assert.ok(gear.includes('gloves'));
    assert.ok(gear.includes('beanie'));
    assert.match(note, /freezing/);
  });

  await t.test('cold adds a warm jacket', () => {
    const { gear, note, factors } = buildOutfitRecommendation(base({ temperatureC: 6 }));
    assert.equal(factors.temperatureBand, 'cold');
    assert.ok(gear.includes('warm jacket'));
    assert.match(note, /cold/);
  });

  await t.test('cool adds a light jacket', () => {
    const { gear, note } = buildOutfitRecommendation(base({ temperatureC: 12 }));
    assert.ok(gear.includes('light jacket'));
    assert.match(note, /cool/);
  });

  await t.test('mild and warm use a light kit only', () => {
    for (const temperatureC of [18, 24]) {
      const { gear } = buildOutfitRecommendation(base({ temperatureC }));
      assert.ok(gear.includes('light kit'));
      assert.equal(gear.includes('light jacket'), false);
      assert.equal(gear.includes('warm jacket'), false);
    }
  });

  await t.test('hot adds an extra water bottle', () => {
    const { gear, note } = buildOutfitRecommendation(base({ temperatureC: 31 }));
    assert.ok(gear.includes('light kit'));
    assert.ok(gear.includes('extra water bottle'));
    assert.match(note, /hot/);
  });

  await t.test('band boundaries are inclusive at the documented thresholds', () => {
    assert.equal(temperatureBand(TEMPERATURE_BANDS.FREEZING_MAX_C), 'freezing');
    assert.equal(temperatureBand(TEMPERATURE_BANDS.COLD_MAX_C), 'cold');
    assert.equal(temperatureBand(TEMPERATURE_BANDS.COOL_MAX_C), 'cool');
    assert.equal(temperatureBand(TEMPERATURE_BANDS.MILD_MAX_C), 'mild');
    assert.equal(temperatureBand(TEMPERATURE_BANDS.WARM_MAX_C), 'warm');
    assert.equal(temperatureBand(TEMPERATURE_BANDS.WARM_MAX_C + 0.1), 'hot');
  });
});

test('outfit engine: precipitation changes both the gear and the wording', async (t) => {
  await t.test('likely rain adds a rain jacket and reports the chance of rain', () => {
    const { gear, note, factors } = buildOutfitRecommendation(
      base({ precipitationProbability: 80, precipitationMm: 2, weatherCode: 63 }),
    );
    assert.equal(factors.precipitationBand, 'rain');
    assert.ok(gear.includes('rain jacket'));
    assert.match(note, /80% chance of rain/);
  });

  await t.test('a meaningful amount of rain is enough even at a low probability', () => {
    const { gear, factors } = buildOutfitRecommendation(
      base({ precipitationProbability: 10, precipitationMm: PRECIPITATION_BANDS.MEANINGFUL_MM }),
    );
    assert.equal(factors.precipitationBand, 'rain');
    assert.ok(gear.includes('rain jacket'));
  });

  await t.test('a moderate chance adds a packable shell instead of a rain jacket', () => {
    const { gear, note, factors } = buildOutfitRecommendation(base({ precipitationProbability: 30 }));
    assert.equal(factors.precipitationBand, 'possible_rain');
    assert.ok(gear.includes('packable rain shell'));
    assert.equal(gear.includes('rain jacket'), false);
    assert.match(note, /slight chance of rain/);
  });

  await t.test('a dry day adds no rain gear', () => {
    const { gear, note, factors } = buildOutfitRecommendation(base());
    assert.equal(factors.precipitationBand, 'dry');
    assert.equal(gear.some((item) => item.includes('rain')), false);
    assert.equal(/rain/.test(note), false);
  });

  await t.test('wet weather at freezing point is described as snow', () => {
    const { gear, note, factors } = buildOutfitRecommendation(
      base({ temperatureC: 1, precipitationProbability: 90, weatherCode: 73 }),
    );
    assert.equal(factors.precipitationBand, 'snow');
    assert.ok(gear.includes('waterproof jacket'));
    assert.ok(gear.includes('gloves'));
    assert.match(note, /snow possible/);
  });
});

test('outfit engine: wind changes the gear and the wording', async (t) => {
  await t.test('breezy adds a windbreaker', () => {
    const { gear, note, factors } = buildOutfitRecommendation(
      base({ windSpeedKph: WIND_BANDS.BREEZY_KPH }),
    );
    assert.equal(factors.windBand, 'breezy');
    assert.ok(gear.includes('windbreaker'));
    assert.match(note, /25 km\/h wind/);
  });

  await t.test('strong wind uses the stronger wording', () => {
    const { gear, note, reasoning } = buildOutfitRecommendation(
      base({ windSpeedKph: WIND_BANDS.STRONG_KPH + 10 }),
    );
    assert.ok(gear.includes('windbreaker'));
    assert.match(note, /50 km\/h wind/);
    assert.ok(reasoning.some((line) => line.includes('expect strong gusts')));
  });

  await t.test('calm adds no wind layer', () => {
    const { gear } = buildOutfitRecommendation(base({ windSpeedKph: 5 }));
    assert.equal(gear.includes('windbreaker'), false);
  });
});

test('outfit engine: all three signals independently influence the wording', () => {
  const calmDryMild = buildOutfitRecommendation(base());
  const colder = buildOutfitRecommendation(base({ temperatureC: 3 }));
  const wetter = buildOutfitRecommendation(base({ precipitationProbability: 75 }));
  const windier = buildOutfitRecommendation(base({ windSpeedKph: 45 }));

  // Identical conditions except one signal -> a different note every time.
  assert.notEqual(calmDryMild.note, colder.note);
  assert.notEqual(calmDryMild.note, wetter.note);
  assert.notEqual(calmDryMild.note, windier.note);
  assert.notEqual(colder.note, wetter.note);
  assert.notEqual(colder.note, windier.note);
  assert.notEqual(wetter.note, windier.note);
});

test('outfit engine: conditions combine into one line', () => {
  const { note, gear } = buildOutfitRecommendation(
    base({ temperatureC: 9, precipitationProbability: 60, windSpeedKph: 35, weatherCode: 61 }),
  );
  assert.ok(gear.includes('light jacket'));
  assert.ok(gear.includes('rain jacket'));
  assert.ok(gear.includes('windbreaker'));
  assert.match(note, /cool \(9°C\), 60% chance of rain, 35 km\/h wind/);
  assert.ok(note.length < 200, 'the note stays short enough to text');
});

test('outfit engine: warm, dry, daylight adds sunscreen but not after dark', () => {
  assert.ok(buildOutfitRecommendation(base({ temperatureC: 25 })).gear.includes('sunscreen'));
  assert.equal(
    buildOutfitRecommendation(base({ temperatureC: 25, isDay: false })).gear.includes('sunscreen'),
    false,
  );
  assert.equal(
    buildOutfitRecommendation(base({ temperatureC: 25, precipitationProbability: 80 })).gear.includes(
      'sunscreen',
    ),
    false,
  );
});

test('outfit engine: the result is deterministic and self-documenting', () => {
  const input = base({ temperatureC: 4, precipitationProbability: 55, windSpeedKph: 42 });

  const first = buildOutfitRecommendation(input);
  const second = buildOutfitRecommendation({ ...input });

  assert.deepEqual(first, second, 'same input must always produce the same recommendation');
  assert.equal(first.gear.length, new Set(first.gear).size, 'gear must not repeat');
  assert.ok(first.reasoning.length >= 4);
  // Every decision is traceable to a threshold that fired.
  assert.ok(first.reasoning.some((line) => /cleats/i.test(line)));
  assert.ok(first.reasoning.some((line) => line.includes('Temperature')));
  assert.ok(first.reasoning.some((line) => line.includes('Precipitation')));
  assert.ok(first.reasoning.some((line) => line.includes('Wind')));
});

test('outfit engine: band helpers and weather-code descriptions', () => {
  assert.equal(windBand(0), 'calm');
  assert.equal(windBand(24.9), 'calm');
  assert.equal(windBand(25), 'breezy');
  assert.equal(windBand(39.9), 'breezy');
  assert.equal(windBand(40), 'strong');

  assert.equal(
    precipitationBand({
      precipitationProbability: 0,
      precipitationMm: 0,
      temperatureC: 20,
      weatherCode: 0,
    }),
    'dry',
  );
  assert.equal(describeWeatherCode(0), 'clear');
  assert.equal(describeWeatherCode(3), 'overcast');
  assert.equal(describeWeatherCode(63), 'rain');
  assert.equal(describeWeatherCode(75), 'snow');
  assert.equal(describeWeatherCode(95), 'thunderstorms');
});

test('outfit engine: rejects input it cannot reason about', () => {
  assert.throws(() => buildOutfitRecommendation(), TypeError);
  assert.throws(() => buildOutfitRecommendation({}), TypeError);
  assert.throws(() => buildOutfitRecommendation({ temperatureC: 'warm' }), TypeError);
  assert.throws(() => buildOutfitRecommendation({ temperatureC: Number.NaN }), TypeError);
});
