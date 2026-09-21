'use strict';

const {
  unprocessable,
  badGateway,
  ERROR_CODES,
  AppError,
} = require('../lib/errors');
const { fetchJson } = require('../lib/http');
const { validateLatitude, validateLongitude, PLACE_PATTERN, MAX_LOCATION_LENGTH } = require('../lib/validate');

/**
 * Geocoding provider (Open-Meteo geocoding API -- public, keyless).
 *
 * Place names are resolved to coordinates + an IANA timezone SERVER-SIDE, at
 * team-creation time, so the stored team always has concrete coordinates and
 * the forecast call never needs to guess. An unresolvable place name is a 422,
 * not a silent fallback to (0, 0).
 */
function createOpenMeteoGeocodingService({
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://geocoding-api.open-meteo.com/v1',
  timeoutMs = 8000,
} = {}) {
  return {
    provider: 'open-meteo-geocoding',

    /**
     * @param {string} query already validated place name
     * @returns {Promise<{latitude:number, longitude:number, timezone:string, resolvedName:string, country?:string, admin1?:string}>}
     */
    async resolvePlace(query) {
      // Defence in depth: the input was validated by the route already, but this
      // service is also called directly from tests and jobs.
      if (typeof query !== 'string' || query.trim() === '') {
        throw unprocessable(ERROR_CODES.LOCATION_UNRESOLVED, 'A place name is required.', [
          { field: 'location', issue: 'empty' },
        ]);
      }
      const trimmed = query.trim();
      if (trimmed.length > MAX_LOCATION_LENGTH || !PLACE_PATTERN.test(trimmed)) {
        throw unprocessable(
          ERROR_CODES.LOCATION_UNRESOLVED,
          'That place name is malformed and cannot be resolved.',
          [{ field: 'location', issue: 'malformed_location' }],
        );
      }

      const url = new URL(`${baseUrl}/search`);
      url.searchParams.set('name', trimmed);
      url.searchParams.set('count', '1');
      url.searchParams.set('language', 'en');
      url.searchParams.set('format', 'json');

      const response = await fetchJson(url, { fetchImpl, timeoutMs });

      if (!response.ok) {
        if (response.status === 0) {
          throw badGateway(ERROR_CODES.GEOCODING_FAILED, 'The geocoding provider could not be reached.');
        }
        throw badGateway(
          ERROR_CODES.GEOCODING_FAILED,
          `The geocoding provider returned HTTP ${response.status}.`,
        );
      }

      const results = response.body && Array.isArray(response.body.results) ? response.body.results : [];

      // Unresolvable / invented place name -> 422 (never reach the weather API).
      if (results.length === 0) {
        throw unprocessable(
          ERROR_CODES.LOCATION_UNRESOLVED,
          `"${trimmed}" could not be resolved to a location.`,
          [{ field: 'location', issue: 'unresolvable', received: trimmed }],
        );
      }

      const match = results[0];

      // Never trust an upstream provider's numbers either.
      let latitude;
      let longitude;
      try {
        latitude = validateLatitude(match.latitude);
        longitude = validateLongitude(match.longitude);
      } catch (error) {
        if (error instanceof AppError) {
          throw badGateway(
            ERROR_CODES.GEOCODING_FAILED,
            'The geocoding provider returned out-of-range coordinates.',
          );
        }
        throw error;
      }

      const timezone =
        typeof match.timezone === 'string' && match.timezone !== '' ? match.timezone : 'UTC';

      const suffixParts = [match.admin1, match.country].filter(
        (part) => typeof part === 'string' && part !== '',
      );

      return {
        latitude,
        longitude,
        timezone,
        resolvedName: suffixParts.length > 0 ? `${match.name}, ${suffixParts.join(', ')}` : match.name,
        country: match.country || null,
        admin1: match.admin1 || null,
      };
    },
  };
}

module.exports = { createOpenMeteoGeocodingService };
