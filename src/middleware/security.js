'use strict';

/**
 * Small set of baseline response headers.
 *
 * A security-header package would be an extra dependency for four lines of
 * value; this app serves an API plus one static page, so the minimal set below
 * is enough, and the CSP makes accidental inline-script injection harder.
 */
function securityHeaders({ isProduction }) {
  return function applySecurityHeaders(_req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    if (isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    res.removeHeader('X-Powered-By');
    next();
  };
}

module.exports = { securityHeaders };
