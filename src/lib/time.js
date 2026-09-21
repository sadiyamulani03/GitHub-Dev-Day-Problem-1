'use strict';

/**
 * Timezone helpers.
 *
 * The practice date of a team is "today" *in the team's own timezone*, not in
 * the server's timezone. Getting this wrong is the classic off-by-one-day bug
 * for a tool that texts parents at 5pm, so all date maths goes through here and
 * is exercised by tests (including a deliberately non-UTC zone).
 */

/** True when `timeZone` is a valid IANA zone understood by this runtime. */
function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    return false;
  }
  try {
    // Throws RangeError for unknown zones.
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Calendar date (YYYY-MM-DD) of `instant` as seen in `timeZone`.
 * Uses the runtime's ICU data rather than manual UTC offset arithmetic.
 */
function toDateInTimeZone(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA formats as YYYY-MM-DD.
  return formatter.format(instant);
}

/** True when `date` is a real calendar date in YYYY-MM-DD form. */
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** Whole days between two YYYY-MM-DD dates (b - a). */
function daysBetween(a, b) {
  const toUtc = (value) => {
    const [y, m, d] = value.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

/** Weekday index (0 = Sunday .. 6 = Saturday) for a YYYY-MM-DD date. */
function weekdayOfIsoDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "17:30" -> 1050 minutes past local midnight. */
function timeToMinutes(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

/** ISO-8601 UTC timestamp, used for all persisted created/updated fields. */
function nowIso() {
  return new Date().toISOString();
}

/**
 * ISO timestamp `hours` from now -- used for session expiry.
 * Expiry is compared as a string against ISO timestamps, which sorts correctly.
 */
function isoHoursFromNow(hours, from = new Date()) {
  return new Date(from.getTime() + hours * 3600 * 1000).toISOString();
}

module.exports = {
  isValidTimeZone,
  toDateInTimeZone,
  isIsoDate,
  daysBetween,
  weekdayOfIsoDate,
  timeToMinutes,
  nowIso,
  isoHoursFromNow,
};
