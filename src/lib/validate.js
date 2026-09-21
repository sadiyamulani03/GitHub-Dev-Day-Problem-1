'use strict';

const { badRequest, ERROR_CODES } = require('./errors');
const { isIsoDate, isValidTimeZone } = require('./time');

/**
 * Server-side input validation (CHECK 5).
 *
 * Nothing here trusts the client: every rule is re-checked on the backend even
 * though the bundled UI also validates the same fields. Each validator either
 * returns a normalised value or throws an AppError with a 400/422 status, so a
 * malformed payload can never reach the geocoder, the weather API or storage.
 */

const MAX_NAME_LENGTH = 80;
const MAX_LOCATION_LENGTH = 200;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

/** Place names: letters (any script), digits and the punctuation real places use. */
const PLACE_PATTERN = /^[\p{L}\p{M}\p{N} .,'’\-/()#]+$/u;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePlainObject(value, field = 'body') {
  if (!isPlainObject(value)) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `Request ${field} must be a JSON object.`);
  }
  return value;
}

function optionalString(value, field, { max = 255 } = {}) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `"${field}" must be a string.`, [
      { field, issue: 'not_a_string' },
    ]);
  }
  if (value.length > max) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `"${field}" must be at most ${max} characters.`, [
      { field, issue: 'too_long', max },
    ]);
  }
  return value.trim();
}

/** Team name: required, non-blank, bounded length, no control characters. */
function validateTeamName(value) {
  const name = optionalString(value, 'name', { max: MAX_NAME_LENGTH });
  if (name === undefined) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, '"name" is required.', [
      { field: 'name', issue: 'required' },
    ]);
  }
  if (name === '') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'Team name must not be empty.', [
      { field: 'name', issue: 'empty' },
    ]);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'Team name contains control characters.', [
      { field: 'name', issue: 'control_characters' },
    ]);
  }
  return name;
}

function validateEmail(value) {
  const email = optionalString(value, 'email', { max: 254 });
  if (email === undefined) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, '"email" is required.', [
      { field: 'email', issue: 'required' },
    ]);
  }
  const normalised = email.toLowerCase();
  // Conservative on purpose, and re-checked server-side regardless of the form.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(normalised) || normalised.length > 254) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'A valid email address is required.', [
      { field: 'email', issue: 'malformed' },
    ]);
  }
  return normalised;
}

function validatePassword(value, field = 'password') {
  if (typeof value !== 'string') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `"${field}" is required and must be a string.`, [
      { field, issue: 'required' },
    ]);
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
      [{ field, issue: 'too_short', min: MIN_PASSWORD_LENGTH }],
    );
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`,
      [{ field, issue: 'too_long', max: MAX_PASSWORD_LENGTH }],
    );
  }
  return value;
}

function validateDisplayName(value, fallback) {
  const name = optionalString(value, 'displayName', { max: MAX_NAME_LENGTH });
  if (name === undefined || name === '') {
    return fallback;
  }
  return name;
}

/** A finite number, or a string that parses to a finite number. Never NaN/Infinity. */
function coerceFiniteNumber(value, field) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw badRequest(ERROR_CODES.VALIDATION_ERROR, `"${field}" must be a finite number.`, [
        { field, issue: 'not_finite' },
      ]);
    }
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, `"${field}" must be a number.`, [
    { field, issue: 'not_a_number' },
  ]);
}

/** Latitude must be a real number inside [-90, 90] (CHECK 5). */
function validateLatitude(value) {
  const latitude = coerceFiniteNumber(value, 'latitude');
  if (latitude < -90 || latitude > 90) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'Latitude must be between -90 and 90.', [
      { field: 'latitude', issue: 'out_of_range', min: -90, max: 90, received: latitude },
    ]);
  }
  return latitude;
}

/** Longitude must be a real number inside [-180, 180] (CHECK 5). */
function validateLongitude(value) {
  const longitude = coerceFiniteNumber(value, 'longitude');
  if (longitude < -180 || longitude > 180) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, 'Longitude must be between -180 and 180.', [
      { field: 'longitude', issue: 'out_of_range', min: -180, max: 180, received: longitude },
    ]);
  }
  return longitude;
}

/** Optional IANA timezone override; must be understood by the runtime. */
function validateTimeZone(value) {
  const timeZone = optionalString(value, 'timezone', { max: 64 });
  if (timeZone === undefined || timeZone === '') {
    return undefined;
  }
  if (!isValidTimeZone(timeZone)) {
    throw badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      `"${timeZone}" is not a recognised IANA timezone.`,
      [{ field: 'timezone', issue: 'invalid_timezone' }],
    );
  }
  return timeZone;
}

/** Practice days: a non-empty list of unique weekday numbers, 0=Sunday..6=Saturday. */
function validatePracticeDays(value, field = 'practiceDays') {
  if (!Array.isArray(value)) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `"${field}" must be an array of weekday numbers.`, [
      { field, issue: 'not_an_array' },
    ]);
  }
  if (value.length === 0) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `"${field}" must contain at least one day.`, [
      { field, issue: 'empty' },
    ]);
  }
  const days = [];
  for (const entry of value) {
    const numeric = typeof entry === 'string' && entry.trim() !== '' ? Number(entry) : entry;
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 6) {
      throw badRequest(
        ERROR_CODES.VALIDATION_ERROR,
        `"${field}" entries must be integers between 0 (Sunday) and 6 (Saturday).`,
        [{ field, issue: 'invalid_weekday', received: entry }],
      );
    }
    days.push(numeric);
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Practice start time in 24h "HH:MM" form. */
function validatePracticeTime(value, field = 'practiceTime') {
  const time = optionalString(value, field, { max: 5 });
  if (time === undefined) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `"${field}" is required (24h "HH:MM").`, [
      { field, issue: 'required' },
    ]);
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `"${field}" must be 24h "HH:MM".`, [
      { field, issue: 'malformed_time', received: time },
    ]);
  }
  return time;
}

/** A practice/forecast date in YYYY-MM-DD form. */
function validatePracticeDate(value, field = 'date') {
  const date = optionalString(value, field, { max: 10 });
  if (date === undefined || date === '') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `"${field}" must be YYYY-MM-DD.`, [
      { field, issue: 'required' },
    ]);
  }
  if (!isIsoDate(date)) {
    throw badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      `"${field}" must be a real date in YYYY-MM-DD form.`,
      [{ field, issue: 'malformed_date', received: date }],
    );
  }
  return date;
}

/**
 * Validate and normalise a team location (CHECK 5).
 *
 * Accepts either:
 *   - a place name : "location": "Cedar Park, Austin"   (the server geocodes it), or
 *   - coordinates  : "latitude": 30.2, "longitude": -97.8
 * The object form `{ location: { place } }` / `{ location: { latitude, longitude } }`
 * is accepted too, so the API is forgiving without ever being unsafe.
 *
 * Rejects: a missing location, a blank/whitespace-only location, malformed place
 * text, and non-numeric / non-finite / out-of-range coordinates.
 *
 * @returns {{type:'place'|'coordinates', query?:string, latitude?:number, longitude?:number, timezone?:string}}
 */
function validateLocation(input, { field = 'location' } = {}) {
  const source = isPlainObject(input) ? input : {};

  const rawLocation = source.location;
  const rawLatitude = source.latitude ?? source.lat;
  const rawLongitude = source.longitude ?? source.lon ?? source.lng;

  let placeInput = rawLocation;
  let latitudeInput = rawLatitude;
  let longitudeInput = rawLongitude;

  if (isPlainObject(rawLocation)) {
    placeInput = rawLocation.place ?? rawLocation.name ?? rawLocation.query;
    latitudeInput = rawLocation.latitude ?? rawLocation.lat ?? rawLatitude;
    longitudeInput = rawLocation.longitude ?? rawLocation.lon ?? rawLocation.lng ?? rawLongitude;
  }

  const hasPlace = placeInput !== undefined && placeInput !== null;
  const hasLatitude = latitudeInput !== undefined && latitudeInput !== null;
  const hasLongitude = longitudeInput !== undefined && longitudeInput !== null;

  // --- Case: nothing at all was supplied ("total absence", CHECK 5) ---
  if (!hasPlace && !hasLatitude && !hasLongitude) {
    throw badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      `${field} is required: provide a place name or coordinates.`,
      [{ field, issue: 'required' }],
    );
  }

  // --- Case: coordinates ---
  if (hasLatitude || hasLongitude) {
    const latitude = validateLatitude(latitudeInput);
    const longitude = validateLongitude(longitudeInput);
    return {
      type: 'coordinates',
      latitude,
      longitude,
      timezone: validateTimeZone(source.timezone),
    };
  }

  // --- Case: place name (server-side geocoded later) ---
  const query = optionalString(placeInput, `${field}.place`, { max: MAX_LOCATION_LENGTH });
  if (query === undefined || query === '') {
    throw badRequest(ERROR_CODES.VALIDATION_ERROR, `${field} must not be empty.`, [
      { field, issue: 'empty' },
    ]);
  }
  if (!PLACE_PATTERN.test(query)) {
    throw badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      `${field} contains characters that are not valid in a place name.`,
      [{ field, issue: 'malformed_location' }],
    );
  }
  return { type: 'place', query, timezone: validateTimeZone(source.timezone) };
}

/**
 * Route parameter `:id` -> positive integer.
 * Rejects SQL-injection-shaped ids, floats and negatives with a 400 instead of
 * letting them reach a query or crash the handler (CHECK 6 + CHECK 7).
 */
function validateId(raw, field = 'id') {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d{1,15}$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  throw badRequest(ERROR_CODES.VALIDATION_ERROR, `"${field}" must be a positive integer id.`, [
    { field, issue: 'malformed_id', received: typeof raw === 'string' ? raw.slice(0, 64) : typeof raw },
  ]);
}

module.exports = {
  MAX_NAME_LENGTH,
  MAX_LOCATION_LENGTH,
  MIN_PASSWORD_LENGTH,
  PLACE_PATTERN,
  isPlainObject,
  requirePlainObject,
  optionalString,
  coerceFiniteNumber,
  validateTeamName,
  validateEmail,
  validatePassword,
  validateDisplayName,
  validateLatitude,
  validateLongitude,
  validateTimeZone,
  validatePracticeDays,
  validatePracticeTime,
  validatePracticeDate,
  validateLocation,
  validateId,
};
