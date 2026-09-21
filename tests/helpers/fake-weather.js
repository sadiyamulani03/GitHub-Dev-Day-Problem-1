'use strict';

/**
 * Test double for the weather provider.
 *
 * The recommendation pipeline is exercised against this instead of the network,
 * which keeps the suite deterministic and offline (CHECK 1 is about *where* the
 * forecast comes from -- the backend -- not about hitting the live API in every
 * test). `tests/live.weather.test.js` covers the real Open-Meteo call.
 */

const DEFAULT_FORECAST = Object.freeze({
  temperatureC: 14.5,
  precipitationProbability: 65,
  precipitationMm: 1.2,
  windSpeedKph: 31,
  weatherCode: 61,
  isDay: true,
});

/** Normalised snapshot the real provider would return, with deterministic values. */
function makeForecast(overrides = {}, params = {}) {
  const merged = { ...DEFAULT_FORECAST, ...overrides };
  return {
    provider: 'fake-weather',
    fetchedAt: '2026-01-01T12:00:00.000Z',
    requestLatitude: params.latitude ?? null,
    requestLongitude: params.longitude ?? null,
    providerLatitude: params.latitude ?? null,
    providerLongitude: params.longitude ?? null,
    elevationM: 10,
    timezone: params.timezone ?? 'America/Chicago',
    utcOffsetSeconds: -18000,
    temperatureC: merged.temperatureC,
    precipitationProbability: merged.precipitationProbability,
    precipitationMm: merged.precipitationMm,
    windSpeedKph: merged.windSpeedKph,
    weatherCode: merged.weatherCode,
    isDay: merged.isDay,
    sampleCount: 2,
    windowStart: `${params.practiceDate}T${params.practiceTime}`,
    windowEnd: `${params.practiceDate}T${params.practiceTime}`,
    samples: [],
  };
}

/**
 * @param {object|Function} weather static overrides, or (params) => overrides
 */
function createFakeWeatherService(weather = {}) {
  const calls = [];

  return {
    provider: 'fake-weather',
    calls,
    /** How many times the backend asked the provider for a forecast. */
    callCount() {
      return calls.length;
    },
    async getPracticeForecast(params) {
      calls.push(params);
      const overrides = typeof weather === 'function' ? weather(params) : weather;
      return makeForecast(overrides || {}, params);
    },
    async getTimeZoneForCoordinates() {
      return 'America/Chicago';
    },
  };
}

/** Test double for the geocoder: resolves known names, rejects everything else. */
function createFakeGeocodingService({ known = {}, timezone = 'America/Chicago' } = {}) {
  const calls = [];
  const table = {
    austin: { latitude: 30.2672, longitude: -97.7431, resolvedName: 'Austin, Texas, United States' },
    'cedar park': {
      latitude: 30.5052,
      longitude: -97.8203,
      resolvedName: 'Cedar Park, Texas, United States',
    },
    boston: { latitude: 42.3601, longitude: -71.0589, resolvedName: 'Boston, Massachusetts, United States' },
    ...known,
  };

  return {
    provider: 'fake-geocoder',
    calls,
    async resolvePlace(query) {
      calls.push(query);
      const match = table[String(query).trim().toLowerCase()];
      if (!match) {
        const { unprocessable, ERROR_CODES } = require('../../src/lib/errors');
        throw unprocessable(
          ERROR_CODES.LOCATION_UNRESOLVED,
          `"${query}" could not be resolved to a location.`,
          [{ field: 'location', issue: 'unresolvable', received: query }],
        );
      }
      return { ...match, timezone, country: 'United States', admin1: null };
    },
  };
}

module.exports = { createFakeWeatherService, createFakeGeocodingService, makeForecast, DEFAULT_FORECAST };
