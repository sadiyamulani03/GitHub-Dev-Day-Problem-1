'use strict';

const { badGateway, ERROR_CODES } = require('../lib/errors');

/**
 * Small `fetch` wrapper with a hard timeout.
 *
 * A hung upstream must not hang a request forever, so every outbound call gets
 * an AbortController deadline. `fetchImpl` is injectable so tests never touch
 * the network.
 */
async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', ...headers },
    });

    if (!response.ok) {
      return { ok: false, status: response.status, body: null };
    }

    return { ok: true, status: response.status, body: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, body: null, error };
  } finally {
    clearTimeout(timer);
  }
}

/** Standard "the upstream provider failed" error (HTTP 502, never a 500 crash). */
function upstreamFailure(provider, detail) {
  return badGateway(
    ERROR_CODES.WEATHER_UNAVAILABLE,
    `The ${provider} provider could not be reached or returned an unusable response.${detail ? ` (${detail})` : ''}`,
  );
}

module.exports = { fetchJson, upstreamFailure };
