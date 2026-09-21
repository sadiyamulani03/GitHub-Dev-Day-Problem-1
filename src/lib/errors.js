'use strict';

/**
 * Application error type.
 *
 * Every error the API returns is an AppError (or is normalised into one by the
 * error middleware), which is what keeps error responses consistent:
 *
 *   { "error": { "code": "TEAM_FORBIDDEN", "message": "...", "details": [...] } }
 *
 * `code` is a stable machine-readable string. `status` is the HTTP status.
 * `details` is optional and only ever contains *validation* information about
 * the caller's own request -- never data belonging to another coach.
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  toJSON() {
    const error = { code: this.code, message: this.message };
    if (Array.isArray(this.details) && this.details.length > 0) {
      error.details = this.details;
    }
    return { error };
  }
}

/** 400 - the caller's input is missing or malformed. */
const badRequest = (code, message, details) => new AppError(400, code, message, details);

/** 401 - no valid server-side session. */
const unauthenticated = (message = 'Authentication is required for this resource.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

/** 403 - the resource exists but is owned by a different coach (CHECK 3 + CHECK 7). */
const forbidden = (code, message) => new AppError(403, code, message);

/** 404 - the resource genuinely does not exist (CHECK 7). */
const notFound = (code, message) => new AppError(404, code, message);

/** 409 - a conflicting state, e.g. an email that is already registered. */
const conflict = (code, message) => new AppError(409, code, message);

/** 422 - syntactically valid input that could not be resolved, e.g. a fake place name. */
const unprocessable = (code, message, details) => new AppError(422, code, message, details);

/** 502 - an upstream provider (weather / geocoding) failed or returned nothing usable. */
const badGateway = (code, message) => new AppError(502, code, message);

/**
 * Error codes used across the app, exported so tests can assert on them
 * instead of on prose messages.
 */
const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_JSON: 'INVALID_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_IN_USE: 'EMAIL_IN_USE',
  NOT_FOUND: 'NOT_FOUND',
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  TEAM_FORBIDDEN: 'TEAM_FORBIDDEN',
  RECOMMENDATION_NOT_FOUND: 'RECOMMENDATION_NOT_FOUND',
  LOCATION_UNRESOLVED: 'LOCATION_UNRESOLVED',
  WEATHER_UNAVAILABLE: 'WEATHER_UNAVAILABLE',
  GEOCODING_FAILED: 'GEOCODING_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

module.exports = {
  AppError,
  ERROR_CODES,
  badRequest,
  unauthenticated,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  badGateway,
};
