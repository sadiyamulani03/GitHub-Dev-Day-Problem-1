'use strict';

const { badGateway, ERROR_CODES } = require('../lib/errors');
const { fetchJson } = require('../lib/http');
const { timeToMinutes } = require('../lib/time');

/**
 * Weather provider (CHECK 1).
 *
 * This is the ONLY place in the application where a forecast enters the system.
 * It is called exclusively from backend request handlers -- the HTTP API never
 * accepts a temperature, a precipitation probability or any other forecast
 * field from a client. A client may choose *which date* to ask about; it cannot
 * supply the weather itself.
 *
 * `fetchImpl` is injectable, so unit and integration tests drive the entire
 * recommendation path with deterministic weather while the production path makes
 * a real Open-Meteo call.
 */

const HOURLY_VARIABLES = [
  'temperature_2m',
  'precipitation_probability',
  'precipitation',
  'wind_speed_10m',
  'weather_code',
  'is_day',
];

/**
 * WMO weather-code severity ranking. Higher = more disruptive to a practice.
 * Used to pick the "worst" code in the practice window so gear is chosen for
 * the conditions a coach is actually going to stand in.
 */
const WMO_SEVERITY = new Map([
  [0, 0], // clear sky
  [1, 1], // mainly clear
  [2, 2], // partly cloudy
  [3, 3], // overcast
  [45, 4], // fog
  [48, 5], // depositing rime fog
  [51, 6], // light drizzle
  [53, 7],
  [55, 8],
  [56, 9], // freezing drizzle
  [57, 10],
  [61, 11], // slight rain
  [63, 12],
  [65, 13],
  [66, 14], // freezing rain
  [67, 15],
  [71, 16], // snow
  [73, 17],
  [75, 18],
  [77, 19], // snow grains
  [80, 20], // rain showers
  [81, 21],
  [82, 22],
  [85, 23], // snow showers
  [86, 24],
  [95, 25], // thunderstorm
  [96, 26], // thunderstorm with hail
  [99, 27],
]);

function weatherCodeSeverity(code) {
  return WMO_SEVERITY.get(code) ?? 0;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Pure aggregation of hourly forecast rows onto a team's practice window.
 *
 * PURE AND DETERMINISTIC: same input -> same output, no clock, no network, no
 * randomness. That property is what makes the recommendation reproducible and
 * unit-testable, and it is asserted directly by the test suite.
 *
 * @param {{time:string[], temperature_2m:number[], precipitation_probability:number[],
 *          precipitation:number[], wind_speed_10m:number[], weather_code:number[],
 *          is_day?:number[]}} hourly
 * @param {{practiceDate:string, practiceTime:string, durationMinutes:number}} window
 * @returns {{temperatureC:number, precipitationProbability:number, precipitationMm:number,
 *            windSpeedKph:number, weatherCode:number, isDay:boolean, sampleCount:number,
 *            windowStart:string, windowEnd:string, samples:Array}}
 */
function aggregatePracticeWindow(hourly, { practiceDate, practiceTime, durationMinutes }) {
  const startMinutes = timeToMinutes(practiceTime);
  const endMinutes = startMinutes + durationMinutes;

  const times = Array.isArray(hourly && hourly.time) ? hourly.time : [];
  const samples = [];

  for (let index = 0; index < times.length; index += 1) {
    const timestamp = times[index]; // e.g. "2026-09-21T17:00"
    if (typeof timestamp !== 'string' || timestamp.length < 16) {
      continue;
    }
    const datePart = timestamp.slice(0, 10);
    if (datePart !== practiceDate) {
      continue;
    }

    // A forecast row covers the whole hour that starts at its timestamp, so a
    // practice window includes every hour it OVERLAPS. This matters: a 17:30
    // practice must still see the 17:00 row (which covers 17:00-18:00), and a
    // window ending exactly on the hour must not pull in the next row.
    const sampleStart = timeToMinutes(timestamp.slice(11, 16));
    const sampleEnd = sampleStart + 60;
    if (sampleStart >= endMinutes || sampleEnd <= startMinutes) {
      continue;
    }

    const temperature = hourly.temperature_2m ? hourly.temperature_2m[index] : null;
    if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
      continue;
    }

    samples.push({
      time: `${datePart}T${timestamp.slice(11, 16)}`,
      temperatureC: temperature,
      precipitationProbability: Number(hourly.precipitation_probability?.[index] ?? 0),
      precipitationMm: Number(hourly.precipitation?.[index] ?? 0),
      windSpeedKph: Number(hourly.wind_speed_10m?.[index] ?? 0),
      weatherCode: Number(hourly.weather_code?.[index] ?? 0),
      isDay: hourly.is_day?.[index] === undefined ? true : Boolean(hourly.is_day[index]),
    });
  }

  if (samples.length === 0) {
    throw badGateway(
      ERROR_CODES.WEATHER_UNAVAILABLE,
      `No forecast hours are available for ${practiceDate} between ${practiceTime} and the end of the practice window.`,
    );
  }

  // Worst weather in the window drives the gear choice; ties go to the earliest hour.
  const worst = samples.reduce((selected, sample) =>
    weatherCodeSeverity(sample.weatherCode) > weatherCodeSeverity(selected.weatherCode)
      ? sample
      : selected,
  );

  const endLabelMinutes = endMinutes % (24 * 60);
  const endLabel = `${String(Math.floor(endLabelMinutes / 60)).padStart(2, '0')}:${String(
    endLabelMinutes % 60,
  ).padStart(2, '0')}`;

  return {
    temperatureC: round(mean(samples.map((sample) => sample.temperatureC)), 1),
    precipitationProbability: Math.round(
      Math.max(...samples.map((sample) => sample.precipitationProbability)),
    ),
    precipitationMm: round(
      samples.reduce((total, sample) => total + sample.precipitationMm, 0),
      2,
    ),
    // Peak wind, not average: gusts are what make a coach reach for a windbreaker.
    windSpeedKph: round(Math.max(...samples.map((sample) => sample.windSpeedKph)), 1),
    weatherCode: worst.weatherCode,
    isDay: samples[0].isDay,
    sampleCount: samples.length,
    windowStart: `${practiceDate}T${practiceTime}`,
    windowEnd: `${practiceDate}T${endLabel}`,
    samples,
  };
}

/**
 * Open-Meteo forecast provider.
 *
 * The returned forecast object is the *only* weather input to the decision
 * engine, and it always records where it came from (`provider`, `fetchedAt`) so
 * a persisted recommendation can be audited back to a real fetch.
 */
function createOpenMeteoWeatherService({
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.open-meteo.com/v1',
  timeoutMs = 8000,
  now = () => new Date(),
} = {}) {
  return {
    provider: 'open-meteo',

    /**
     * Forecast for a team's practice window. Coordinates must already be
     * validated and stored on the team by the time this is called.
     *
     * @returns {Promise<object>} normalised forecast snapshot
     */
    async getPracticeForecast({ latitude, longitude, practiceDate, practiceTime, durationMinutes }) {
      const url = new URL(`${baseUrl}/forecast`);
      url.searchParams.set('latitude', String(latitude));
      url.searchParams.set('longitude', String(longitude));
      url.searchParams.set('hourly', HOURLY_VARIABLES.join(','));
      url.searchParams.set('temperature_unit', 'celsius');
      url.searchParams.set('wind_speed_unit', 'kmh');
      url.searchParams.set('precipitation_unit', 'mm');
      // Let the provider resolve the timezone for these coordinates: the team's
      // "today" and the forecast's local hours then agree.
      url.searchParams.set('timezone', 'auto');
      url.searchParams.set('start_date', practiceDate);
      url.searchParams.set('end_date', practiceDate);

      const response = await fetchJson(url, { fetchImpl, timeoutMs });

      if (!response.ok) {
        throw badGateway(
          ERROR_CODES.WEATHER_UNAVAILABLE,
          response.status === 0
            ? 'The weather provider could not be reached.'
            : `The weather provider returned HTTP ${response.status}.`,
        );
      }

      const body = response.body;
      if (!body || typeof body !== 'object' || !body.hourly) {
        throw badGateway(ERROR_CODES.WEATHER_UNAVAILABLE, 'The weather provider returned no hourly data.');
      }

      const aggregated = aggregatePracticeWindow(body.hourly, {
        practiceDate,
        practiceTime,
        durationMinutes,
      });

      return {
        provider: 'open-meteo',
        fetchedAt: now().toISOString(),
        requestLatitude: latitude,
        requestLongitude: longitude,
        providerLatitude: typeof body.latitude === 'number' ? body.latitude : null,
        providerLongitude: typeof body.longitude === 'number' ? body.longitude : null,
        elevationM: typeof body.elevation === 'number' ? body.elevation : null,
        timezone: typeof body.timezone === 'string' ? body.timezone : 'UTC',
        utcOffsetSeconds:
          typeof body.utc_offset_seconds === 'number' ? body.utc_offset_seconds : null,
        temperatureC: aggregated.temperatureC,
        precipitationProbability: aggregated.precipitationProbability,
        precipitationMm: aggregated.precipitationMm,
        windSpeedKph: aggregated.windSpeedKph,
        weatherCode: aggregated.weatherCode,
        isDay: aggregated.isDay,
        sampleCount: aggregated.sampleCount,
        windowStart: aggregated.windowStart,
        windowEnd: aggregated.windowEnd,
        samples: aggregated.samples,
      };
    },

    /**
     * Resolve the IANA timezone for a raw coordinate pair. Used once, at team
     * creation, when a coach supplies coordinates instead of a place name.
     */
    async getTimeZoneForCoordinates({ latitude, longitude }) {
      const url = new URL(`${baseUrl}/forecast`);
      url.searchParams.set('latitude', String(latitude));
      url.searchParams.set('longitude', String(longitude));
      url.searchParams.set('timezone', 'auto');
      url.searchParams.set('forecast_days', '1');
      url.searchParams.set('hourly', 'temperature_2m');

      const response = await fetchJson(url, { fetchImpl, timeoutMs });

      if (!response.ok) {
        throw badGateway(
          ERROR_CODES.WEATHER_UNAVAILABLE,
          response.status === 0
            ? 'The weather provider could not be reached while resolving the location timezone.'
            : `The weather provider returned HTTP ${response.status} while resolving the location timezone.`,
        );
      }

      const timezone = response.body && response.body.timezone;
      if (typeof timezone !== 'string' || timezone === '') {
        throw badGateway(ERROR_CODES.WEATHER_UNAVAILABLE, 'The weather provider returned no timezone.');
      }
      return timezone;
    },
  };
}

// APPEND_MARKER

module.exports = {
  HOURLY_VARIABLES,
  weatherCodeSeverity,
  aggregatePracticeWindow,
  createOpenMeteoWeatherService,
};
