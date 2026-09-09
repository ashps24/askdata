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
 *   email "a.p@northwind.com" -> "a•••@northwind.com"
 *                                           keeps the domain, so "is this the
 *                                           right company?" is still answerable
 *   phone "+91 98400 12345" -> "+91 ••••• •2345"
 *                                           keeps country code and last four,
 *                                           which is how a customer confirms a
 *                                           number over a call
 *
 * Aggregates are never masked: `COUNT(EMAIL)` contains no personal data, and
 * masking a number would just make the answer useless.
 */

const DOT = '•';

function maskEmail(value) {
  const s = String(value);
  const at = s.lastIndexOf('@');
  if (at <= 0) return maskGeneric(s);
  const local = s.slice(0, at);
  const domain = s.slice(at);
  const keep = local.slice(0, 1);
  return `${keep}${DOT.repeat(Math.max(3, local.length - 1))}${domain}`;
}

function maskPhone(value) {
  const s = String(value);
  const digits = s.replace(/\D/g, '');
  if (digits.length < 5) return DOT.repeat(s.length);

  // Keep a country code when the number is written with one, plus the last 4.
  const cc = s.trimStart().startsWith('+') ? digits.slice(0, digits.length > 10 ? digits.length - 10 : 0) : '';
  const last4 = digits.slice(-4);
  const hiddenCount = digits.length - cc.length - 4;
  const head = cc ? `+${cc} ` : '';
  return `${head}${DOT.repeat(Math.max(1, hiddenCount))} ${DOT}${last4}`.trim();
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

module.exports = { maskRows, maskValue, piiKindFor, maskEmail, maskPhone, maskName, DOT };
