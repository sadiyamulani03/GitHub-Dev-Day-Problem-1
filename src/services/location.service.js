'use strict';

/**
 * Location resolution.
 *
 * The output of this module is what actually gets stored on a team: concrete
 * latitude, longitude, a human-readable resolved name and an IANA timezone.
 * Both branches are server-side, so a client can never inject a location that
 * the backend has not validated and resolved itself.
 */
async function resolveLocation(location, { geocodingService, weatherService }) {
  if (location.type === 'coordinates') {
    // Coordinates were already range-checked by the validator. We still need a
    // timezone, which we ask the weather provider to resolve for that point.
    const timezone =
      location.timezone ||
      (await weatherService.getTimeZoneForCoordinates({
        latitude: location.latitude,
        longitude: location.longitude,
      }));

    return {
      locationType: 'coordinates',
      locationQuery: null,
      latitude: location.latitude,
      longitude: location.longitude,
      resolvedName: `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`,
      timezone,
    };
  }

  const resolved = await geocodingService.resolvePlace(location.query);

  return {
    locationType: 'place',
    locationQuery: location.query,
    latitude: resolved.latitude,
    longitude: resolved.longitude,
    resolvedName: resolved.resolvedName,
    // An explicit, validated timezone from the coach wins over the provider's.
    timezone: location.timezone || resolved.timezone,
  };
}

module.exports = { resolveLocation };
