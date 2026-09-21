'use strict';

const { AppError, ERROR_CODES } = require('../lib/errors');

/**
 * Consistent error handling.
 *
 * Every failure leaves the API in the same shape:
 *
 *   { "error": { "code": "...", "message": "...", "details": [...] } }
 *
 * Unexpected errors are logged server-side and reported as a generic 500: an
 * internal message or stack trace never reaches the client. In particular,
 * malformed JSON is turned into a 400 rather than escaping as an unhandled
 * exception, and nothing here is allowed to crash the process.
 */

function notFoundHandler(req, _res, next) {
  next(
    new AppError(404, ERROR_CODES.NOT_FOUND, `No route matches ${req.method} ${req.path}.`),
  );
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
function errorHandler(error, req, res, next) {
  // express.json() rejects malformed bodies by throwing a SyntaxError.
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res
      .status(400)
      .json(new AppError(400, ERROR_CODES.INVALID_JSON, 'Request body is not valid JSON.').toJSON());
  }

  if (error && error.type === 'entity.too.large') {
    return res
      .status(413)
      .json(new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, 'Request body is too large.').toJSON());
  }

  if (error instanceof AppError) {
    return res.status(error.status).json(error.toJSON());
  }

  // Unexpected: log with context, return an opaque 500.
  // eslint-disable-next-line no-console
  console.error('[unhandled-error]', req.method, req.originalUrl, error);
  return res
    .status(500)
    .json(
      new AppError(500, ERROR_CODES.INTERNAL_ERROR, 'An unexpected server error occurred.').toJSON(),
    );
}

module.exports = { notFoundHandler, errorHandler };
