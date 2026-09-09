'use strict';

/**
 * One representation of time, used everywhere.
 *
 * THE BUG THIS PREVENTS. Data Store datetimes are naive - no offset, stored in
 * the project's timezone (Asia/Kolkata here). If a value is written from
 * `toISOString()` (UTC) and later rendered "in IST" by a formatter that
 * converts, every timestamp shifts by 5:30. The 02:14 export in the security
 * question would be reported to the customer as 07:44, which is not a rounding
 * error - it is the wrong fact, and it is the fact the answer turns on.
 *
 * So the rule is: every stored datetime is IST wall-clock, and formatting never
 * converts. `istNaive` is the only way a Date becomes a stored string, and
 * `parts` is the only way a stored string is read back.
 */

const IST_OFFSET_MINUTES = 5 * 60 + 30;

/** A Date -> "YYYY-MM-DD HH:MM:SS" in IST wall-clock. */
function istNaive(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const shifted = new Date(d.getTime() + IST_OFFSET_MINUTES * 60000);
  return shifted.toISOString().replace('T', ' ').slice(0, 19);
}

/** A Date -> "YYYY-MM-DD" in IST. */
function istDay(date = new Date()) {
  return istNaive(date).slice(0, 10);
}

/** Split a stored naive string into parts. No conversion, ever. */
function parts(value) {
  const s = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  return {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: m[4] === undefined ? null : Number(m[4]),
    minute: m[5] === undefined ? null : Number(m[5]),
    second: m[6] === undefined ? 0 : Number(m[6]),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Aug 2026" */
function formatDate(value) {
  const p = parts(value);
  if (!p) return value === null || value === undefined ? null : String(value);
  return `${String(p.day).padStart(2, '0')} ${MONTHS[p.month - 1]} ${p.year}`;
}

/** "12 Aug 2026, 10:22 IST" - the stored wall-clock, relabelled, not shifted. */
function formatDateTime(value) {
  const p = parts(value);
  if (!p) return value === null || value === undefined ? null : String(value);
  if (p.hour === null) return formatDate(value);
  return `${formatDate(value)}, ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} IST`;
}

/** Compare two naive strings. Lexicographic order is chronological for this shape. */
function isBefore(a, b) {
  return String(a ?? '') < String(b ?? '');
}

/** `days` before now, as an IST naive string. */
function daysAgoNaive(days, hour = null, minute = null) {
  const d = new Date(Date.now() - days * 86400000);
  const s = istNaive(d);
  if (hour === null) return s;
  return `${s.slice(0, 11)}${String(hour).padStart(2, '0')}:${String(minute ?? 0).padStart(2, '0')}:00`;
}

module.exports = {
  istNaive, istDay, parts, formatDate, formatDateTime, isBefore, daysAgoNaive,
  IST_OFFSET_MINUTES, MONTHS,
};
