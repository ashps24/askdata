'use strict';

/**
 * PII masking.
 *
 * WHERE THIS RUNS MATTERS MORE THAN HOW. Masking happens on the server, after
 * the query returns and before the response is serialised. A masked value that
 * travelled to the browser in the clear is not masked - it is in devtools, in
 * the HAR file, and in any proxy log along the way. So the raw value never
 * leaves this process except through `/reveal`, which is audited per row.
 *
 * The masks are chosen so a support engineer can still do their job:
 *
 *   name  "Ashwin Prakash" -> "Ashwin P."   keeps the surname initial, which is
 *                                           what distinguishes two Ashwins in a
 *                                           clarify list (rule 4)
 *   email "a.p@northwind.com" -> "#REDACTED"
 *   phone "+91 98400 12345"   -> "#REDACTED"
 *
 * Contact details are redacted outright rather than partially starred out.
 * A row of "a•••••••••@northwind.example.com" reads as damage - the engineer
 * squints at it, tries to reconstruct it, and cannot use it either way. A
 * REDACTED label says plainly that there IS a value and that asking for it is
 * a deliberate, logged act. In the client it is the button: click it and the
 * real value replaces it, and that click writes an audit row.
 *
 * Names are the exception and stay partially masked. "Ashwin Prakash" ->
 * "Ashwin P." is what lets an engineer tell two Ashwins apart in a clarify
 * list, which is rule 4 working; redacting names would make that list useless.
 *
 * Aggregates are never masked: `COUNT(EMAIL)` contains no personal data, and
 * masking a number would just make the answer useless.
 */

const DOT = '•';

/** The label a redacted value carries. The client turns it into the button. */
const REDACTED = '#REDACTED';

function maskEmail(value) {
  return String(value) ? REDACTED : String(value);
}

function maskPhone(value) {
  return String(value) ? REDACTED : String(value);
}

function maskName(value) {
  const s = String(value).trim();
  if (!s) return s;
  const parts = s.split(/\s+/);
  if (parts.length === 1) {
    return `${parts[0].slice(0, 1)}${DOT.repeat(Math.max(2, parts[0].length - 1))}`;
  }
  const last = parts[parts.length - 1];
  return `${parts.slice(0, -1).join(' ')} ${last.slice(0, 1)}.`;
}

function maskGeneric(value) {
  const s = String(value);
  return s.length <= 2 ? DOT.repeat(s.length) : `${s.slice(0, 1)}${DOT.repeat(s.length - 1)}`;
}

const MASKERS = { email: maskEmail, phone: maskPhone, name: maskName };

/** Mask one value by kind. Null and empty pass through - there is nothing to hide. */
function maskValue(value, kind) {
  if (value === null || value === undefined || value === '') return value;
  return (MASKERS[kind] ?? maskGeneric)(value);
}

/**
 * Is this result column a PII column of a table in the query?
 *
 * Result keys come back bare (`EMAIL`) or, with a join, wrapped per table -
 * lib/replica.js flattens them first, so here we only see bare names and have
 * to decide from the tables the query touched. If two joined tables both have
 * an `EMAIL`, either way it is PII, so the ambiguity is harmless.
 *
 * An aggregate expression is never PII: `COUNT(EMAIL)` is a number.
 */
function piiKindFor(column, tables, loaded) {
  if (/^(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(column)) return null;
  for (const table of tables) {
    const kind = loaded.pii[table]?.[column.toUpperCase()];
    if (kind) return kind;
  }
  return null;
}

/**
 * Mask a whole result set.
 *
 * Returns `{ rows, masked }` where `masked` lists the columns that were
 * redacted, so the client can offer Reveal on exactly those and the answer can
 * say what is hidden.
 */
function maskRows(rows, tables, loaded) {
  if (!rows.length) return { rows, masked: [] };

  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const kinds = new Map();
  for (const col of columns) {
    const kind = piiKindFor(col, tables, loaded);
    if (kind) kinds.set(col, kind);
  }
  if (!kinds.size) return { rows, masked: [] };

  const out = rows.map((row) => {
    const copy = { ...row };
    for (const [col, kind] of kinds) {
      if (col in copy) copy[col] = maskValue(copy[col], kind);
    }
    return copy;
  });

  return { rows: out, masked: [...kinds.keys()] };
}

module.exports = {
  REDACTED, maskRows, maskValue, piiKindFor, maskEmail, maskPhone, maskName, DOT };
