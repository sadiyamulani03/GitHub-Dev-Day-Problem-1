'use strict';

/**
 * Practice-day outfit/gear decision engine (PHASE 4).
 *
 * PURE. This module imports nothing, performs no I/O, reads no clock and uses
 * no randomness: `buildOutfitRecommendation(weather)` is a total function of its
 * input, which is what makes recommendations reproducible and cheap to test.
 * (A deterministic rule table is the right tool here -- an LLM call would add
 * latency, cost and non-determinism to what is fundamentally a threshold lookup.)
 *
 * All three signals change the wording, and the `reasoning` array records
 * exactly which threshold fired, so a coach (or a reviewer) can audit the call:
 *
 *   temperature   -> jacket / insulated layers / gloves / beanie / extra water
 *   precipitation -> rain jacket / packable rain shell + the "chance of rain" text
 *   wind          -> windbreaker, with stronger wording above 40 km/h
 */

const TEMPERATURE_BANDS = Object.freeze({
  FREEZING_MAX_C: 2,
  COLD_MAX_C: 8,
  COOL_MAX_C: 15,
  MILD_MAX_C: 21,
  WARM_MAX_C: 26,
  // Above WARM_MAX_C counts as "hot".
});

const PRECIPITATION_BANDS = Object.freeze({
  LIKELY_PROBABILITY_PCT: 50,
  POSSIBLE_PROBABILITY_PCT: 20,
  MEANINGFUL_MM: 0.5,
  // At or below this temperature, wet weather is described as snow.
  SNOW_MAX_TEMP_C: 3,
});

const WIND_BANDS = Object.freeze({
  BREEZY_KPH: 25,
  STRONG_KPH: 40,
});

/** WMO weather codes that mean rain / snow is already happening. */
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

function temperatureBand(temperatureC) {
  if (temperatureC <= TEMPERATURE_BANDS.FREEZING_MAX_C) return 'freezing';
  if (temperatureC <= TEMPERATURE_BANDS.COLD_MAX_C) return 'cold';
  if (temperatureC <= TEMPERATURE_BANDS.COOL_MAX_C) return 'cool';
  if (temperatureC <= TEMPERATURE_BANDS.MILD_MAX_C) return 'mild';
  if (temperatureC <= TEMPERATURE_BANDS.WARM_MAX_C) return 'warm';
  return 'hot';
}

function precipitationBand({ precipitationProbability, precipitationMm, temperatureC, weatherCode }) {
  const sleeting = temperatureC <= PRECIPITATION_BANDS.SNOW_MAX_TEMP_C;
  const wet = RAIN_CODES.has(weatherCode) || SNOW_CODES.has(weatherCode);
  const likely =
    precipitationProbability >= PRECIPITATION_BANDS.LIKELY_PROBABILITY_PCT ||
    precipitationMm >= PRECIPITATION_BANDS.MEANINGFUL_MM;

  if (wet || likely) {
    return sleeting ? 'snow' : 'rain';
  }
  if (precipitationProbability >= PRECIPITATION_BANDS.POSSIBLE_PROBABILITY_PCT) {
    return 'possible_rain';
  }
  return 'dry';
}

function windBand(windSpeedKph) {
  if (windSpeedKph >= WIND_BANDS.STRONG_KPH) return 'strong';
  if (windSpeedKph >= WIND_BANDS.BREEZY_KPH) return 'breezy';
  return 'calm';
}

/** Weather-code description, used only for the human-readable summary line. */
function describeWeatherCode(code) {
  if (code === 0) return 'clear';
  if (code === 1) return 'mainly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'foggy';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code >= 61 && code <= 67) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain showers';
  if (code === 85 || code === 86) return 'snow showers';
  if (code >= 95) return 'thunderstorms';
  return 'mixed conditions';
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Turn a forecast snapshot into a persisted outfit/gear call.
 *
 * @param {{temperatureC:number, precipitationProbability?:number, precipitationMm?:number,
 *          windSpeedKph?:number, weatherCode?:number, isDay?:boolean}} weather
 * @returns {{note:string, gear:string[], reasoning:string[], factors:object}}
 */
function buildOutfitRecommendation(weather) {
  if (!weather || typeof weather.temperatureC !== 'number' || !Number.isFinite(weather.temperatureC)) {
    throw new TypeError('buildOutfitRecommendation requires a finite temperatureC value.');
  }

  const temperatureC = weather.temperatureC;
  const precipitationProbability = Number(weather.precipitationProbability ?? 0);
  const precipitationMm = Number(weather.precipitationMm ?? 0);
  const windSpeedKph = Number(weather.windSpeedKph ?? 0);
  const weatherCode = Number(weather.weatherCode ?? 0);
  const isDay = weather.isDay === undefined ? true : Boolean(weather.isDay);

  const tempBand = temperatureBand(temperatureC);
  const precipBand = precipitationBand({
    precipitationProbability,
    precipitationMm,
    temperatureC,
    weatherCode,
  });
  const wind = windBand(windSpeedKph);

  const gear = [];
  const reasoning = [];
  const add = (item) => {
    if (!gear.includes(item)) {
      gear.push(item);
    }
  };

  // Every soccer practice starts with cleats.
  add('cleats');
  reasoning.push('Cleats are part of every practice-day call.');

  // --- Temperature band -----------------------------------------------------
  if (tempBand === 'freezing') {
    add('insulated jacket');
    add('gloves');
    add('beanie');
    reasoning.push(
      `Temperature ${round(temperatureC, 1)}°C is at or below ${TEMPERATURE_BANDS.FREEZING_MAX_C}°C (freezing) -> insulated jacket, gloves and beanie.`,
    );
  } else if (tempBand === 'cold') {
    add('warm jacket');
    add('gloves');
    reasoning.push(
      `Temperature ${round(temperatureC, 1)}°C is at or below ${TEMPERATURE_BANDS.COLD_MAX_C}°C (cold) -> warm jacket and gloves.`,
    );
  } else if (tempBand === 'cool') {
    add('light jacket');
    reasoning.push(
      `Temperature ${round(temperatureC, 1)}°C is at or below ${TEMPERATURE_BANDS.COOL_MAX_C}°C (cool) -> light jacket.`,
    );
  } else if (tempBand === 'mild') {
    add('light kit');
    reasoning.push(`Temperature ${round(temperatureC, 1)}°C is mild -> light kit, no extra layer needed.`);
  } else if (tempBand === 'warm') {
    add('light kit');
    reasoning.push(`Temperature ${round(temperatureC, 1)}°C is warm -> light kit.`);
  } else {
    add('light kit');
    add('extra water bottle');
    reasoning.push(
      `Temperature ${round(temperatureC, 1)}°C is above ${TEMPERATURE_BANDS.WARM_MAX_C}°C (hot) -> light kit and an extra water bottle.`,
    );
  }

  // --- Precipitation band ---------------------------------------------------
  if (precipBand === 'rain') {
    add('rain jacket');
    reasoning.push(
      `Precipitation ${round(precipitationProbability)}% / ${round(precipitationMm, 2)} mm, code ${weatherCode} (${describeWeatherCode(weatherCode)}) -> rain jacket.`,
    );
  } else if (precipBand === 'snow') {
    add('waterproof jacket');
    add('gloves');
    reasoning.push(
      `Wet weather at ${round(temperatureC, 1)}°C (at or below ${PRECIPITATION_BANDS.SNOW_MAX_TEMP_C}°C) -> waterproof jacket and gloves for snow.`,
    );
  } else if (precipBand === 'possible_rain') {
    add('packable rain shell');
    reasoning.push(
      `Precipitation ${round(precipitationProbability)}% is at or above ${PRECIPITATION_BANDS.POSSIBLE_PROBABILITY_PCT}% -> packable rain shell, just in case.`,
    );
  } else {
    reasoning.push(
      `Precipitation ${round(precipitationProbability)}% / ${round(precipitationMm, 2)} mm is below the wet-weather thresholds -> no rain gear needed.`,
    );
  }

  // --- Wind band ------------------------------------------------------------
  if (wind === 'strong') {
    add('windbreaker');
    reasoning.push(
      `Wind ${round(windSpeedKph, 1)} km/h is at or above ${WIND_BANDS.STRONG_KPH} km/h (strong) -> windbreaker, expect strong gusts.`,
    );
  } else if (wind === 'breezy') {
    add('windbreaker');
    reasoning.push(
      `Wind ${round(windSpeedKph, 1)} km/h is at or above ${WIND_BANDS.BREEZY_KPH} km/h (breezy) -> windbreaker.`,
    );
  } else {
    reasoning.push(`Wind ${round(windSpeedKph, 1)} km/h is below ${WIND_BANDS.BREEZY_KPH} km/h -> no wind layer needed.`);
  }

  // --- Sun: warm, dry and in daylight ---------------------------------------
  if (temperatureC >= 22 && precipBand === 'dry' && isDay) {
    add('sunscreen');
    reasoning.push('Warm, dry and daytime -> sunscreen.');
  }

  // --- One-line summary (what a coach actually texts the group chat) --------
  const summary = [`${tempBand} (${round(temperatureC, 1)}°C)`];
  if (precipBand === 'rain') {
    summary.push(`${round(precipitationProbability)}% chance of rain`);
  } else if (precipBand === 'possible_rain') {
    summary.push(`slight chance of rain (${round(precipitationProbability)}%)`);
  } else if (precipBand === 'snow') {
    summary.push('snow possible');
  } else if (wind === 'calm') {
    summary.push(describeWeatherCode(weatherCode));
  }
  if (wind !== 'calm') {
    summary.push(`${round(windSpeedKph, 1)} km/h wind`);
  }

  const note = `${gear.join(' + ')}, ${summary.join(', ')}`;

  return {
    note,
    gear,
    reasoning,
    factors: {
      temperatureBand: tempBand,
      precipitationBand: precipBand,
      windBand: wind,
      temperatureC: round(temperatureC, 1),
      precipitationProbability: round(precipitationProbability),
      precipitationMm: round(precipitationMm, 2),
      windSpeedKph: round(windSpeedKph, 1),
      weatherCode,
      isDay,
    },
  };
}

module.exports = {
  TEMPERATURE_BANDS,
  PRECIPITATION_BANDS,
  WIND_BANDS,
  temperatureBand,
  precipitationBand,
  windBand,
  describeWeatherCode,
  buildOutfitRecommendation,
};
