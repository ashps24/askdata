'use strict';

/**
 * The read path, and the honesty about it.
 *
 * WHAT IS REAL AND WHAT IS NOT. The design calls for reads to go to the
 * customer's regional read replica, with per-org, per-DC credentials. That is
 * not something this deployment can do: Catalyst Data Store has no replica
 * concept, and there are no per-customer database credentials to resolve. So:
 *
 *   - `dc` IS resolved from the org record and carried through every response
 *     and every audit row. Nothing assumes one DC.
 *   - `as_of` IS real - the wall-clock instant the read completed.
 *   - `lag_seconds` is NOT measured. There is no replica to be behind. It comes
 *     from configuration (`ASKDATA_LAG_<DC>` or `ASKDATA_LAG_DEFAULT`) so the
 *     freshness path is exercised by a real value rather than being dead code,
 *     and `source` says plainly which it was.
 *
 * `read()` is the single seam. A real replica client would replace its body and
 * report true lag; nothing above it would change. Everything that consumes lag -
 * the caveat in the answer, the `as_of` line in the ticket comment - is already
 * written against that seam.
 *
 * Why carry lag at all when it is configured? Because the *behaviour* it drives
 * is the point: a support engineer telling a customer "the source is Web" about
 * a record edited twenty seconds ago is worse than one saying "I can see it as
 * of a minute ago". Building that path now means it works the day a replica
 * appears.
 */

/** Lag is only reported above this; below it, freshness is not worth the words. */
const time = require('./time');

const CAVEAT_THRESHOLD_SECONDS = 60;

const DCS = ['in', 'com', 'eu', 'au', 'jp', 'ca', 'sa', 'uae'];

/** Resolve the data centre from the org record. Never assume one. */
function resolveDc(org) {
  const dc = String(org?.DC ?? '').toLowerCase().trim();
  if (!DCS.includes(dc)) {
    throw new Error(`Org ${org?.ORG_ID ?? '?'} has no usable DC (${org?.DC ?? 'unset'}).`);
  }
  return dc;
}

/** Configured lag for a DC, in seconds. 0 when unset. */
function configuredLag(dc) {
  const raw =
    process.env[`ASKDATA_LAG_${dc.toUpperCase()}`] ??
    process.env.ASKDATA_LAG_DEFAULT ??
    '0';
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Flatten a ZCQL result set.
 *
 * `executeZCQLQuery` wraps each row under its table name - and with a join,
 * under every table or alias in the query, so one logical row arrives as
 * `{ Users: {...}, Profiles: {...} }`. Aggregates come back under a key that
 * depends on the query. Rather than guessing the key, merge every
 * object-valued property: the result is the flat row callers expect whatever
 * the shape.
 */
function flattenRows(result) {
  if (!Array.isArray(result)) return [];
  return result.map((row) => {
    if (!row || typeof row !== 'object') return {};
    const values = Object.values(row);
    const wrapped = values.length > 0 && values.every((v) => v && typeof v === 'object' && !Array.isArray(v));
    return wrapped ? Object.assign({}, ...values) : { ...row };
  });
}

/**
 * Data Store returns booleans as the strings 'true'/'false' on some paths and
 * real booleans on others. In JavaScript `"false"` is truthy, so anything
 * downstream that tests these gets it backwards. Normalise once, here.
 */
function normaliseValues(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === 'true') out[k] = true;
      else if (v === 'false') out[k] = false;
      else out[k] = v;
    }
    return out;
  });
}

/**
 * Run one read for one org.
 *
 * Returns { rows, columns, as_of, lag_seconds, stale, dc, source }.
 */
async function read(catalystApp, org, zcql) {
  const dc = resolveDc(org);
  const started = Date.now();

  const raw = await catalystApp.zcql().executeZCQLQuery(zcql);

  const rows = normaliseValues(flattenRows(raw));
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lag = configuredLag(dc);
  const at = new Date();

  return {
    rows,
    columns,
    dc,
    ms: Date.now() - started,
    // IST wall-clock, like every other datetime in the app.
    as_of: time.istNaive(new Date(at.getTime() - lag * 1000)),
    read_at: time.istNaive(at),
    lag_seconds: lag,
    stale: lag > CAVEAT_THRESHOLD_SECONDS,
    source: lag > 0
      ? `configured replica lag for dc=${dc} (no live replica in this deployment)`
      : `primary datastore, dc=${dc} (no replica configured)`,
  };
}

module.exports = {
  read, resolveDc, configuredLag, flattenRows, normaliseValues,
  CAVEAT_THRESHOLD_SECONDS, DCS,
};
