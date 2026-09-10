'use strict';

/**
 * A durable spool for audit rows that cannot be inserted right now.
 *
 * WHY THIS EXISTS
 *
 * "Every query is audited" is one of this tool's four guarantees, and it was
 * being broken silently: SupportQueryLog is written one row per question via
 * insertRow, that meter ran out, and answers kept flowing with no trail behind
 * them. Enabling billing fixes the meter, but a guarantee that evaporates when
 * a counter runs out was never really a guarantee - the trail should survive
 * the store being briefly unwritable, whatever the reason.
 *
 * SO WHY STRATUS
 *
 * The requirement is: durable, immediate, and enumerable later. Of what is
 * actually available here -
 *
 *   Data Store insertRow  the thing that is broken
 *   Data Store bulk write works, but it is an async job - too heavy per query
 *   Cache                 works, but the SDK has no way to list keys, so a
 *                         spool written into it could never be found again
 *   File Store            uploads work, but the SDK lists folders, not files
 *   Stratus               put, LIST and delete - all three
 *
 * - Stratus is the only one that can be both written a row at a time and read
 * back as a set. One object per entry, so two concurrent questions cannot
 * overwrite each other's audit row: an append-only log with a lost-update bug
 * would be worse than no log, because it would look complete.
 *
 * The spool is a holding area, not the record. `drain()` moves entries into
 * SupportQueryLog by bulk write - a different meter, and the one path that
 * still works - and deletes them only once the rows have landed.
 */

const BUCKET = process.env.ASKDATA_SPOOL_BUCKET || 'askdata-audit-spool';
const PREFIX = 'pending/';

/** Distinct per entry even within the same millisecond in the same instance. */
let seq = 0;
function keyFor() {
  seq = (seq + 1) % 100000;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${PREFIX}${Date.now()}-${String(seq).padStart(5, '0')}-${rand}.json`;
}

function bucket(catalystApp) {
  return catalystApp.stratus().bucket(BUCKET);
}

/**
 * getObject resolves to a Readable, not a Buffer or a string. Stringifying it
 * yields "[object Object]", every JSON.parse throws, and because a bad object
 * is skipped rather than raised, the spool reads as empty while it is full.
 */
async function readBody(body) {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Hold one audit row. Never throws: a failure here must not turn an answered
 * question into a 500, but it IS reported so the caller can say so on the
 * response rather than pretending the row was written.
 */
async function write(catalystApp, row) {
  try {
    const key = keyFor();
    await bucket(catalystApp).putObject(key, JSON.stringify(row));
    return { ok: true, key };
  } catch (err) {
    console.error(`[SECURITY] askdata SPOOL WRITE FAILED: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** Every entry currently waiting, newest last. Returns [{ key, row }]. */
async function list(catalystApp, limit = 500) {
  const out = [];
  try {
    let continuationToken;
    do {
      // maxKeys is a STRING and the continuation field is
      // `next_continuation_token` - passing the shapes the names suggest
      // returns an empty page rather than an error, so the spool looked empty
      // while it was filling up.
      const page = await bucket(catalystApp).listPagedObjects({
        prefix: PREFIX,
        maxKeys: String(Math.min(limit, 100)),
        ...(continuationToken ? { continuationToken } : {}),
      });
      // `contents` holds StratusObject instances, not plain records - the
      // key lives on `keyDetails`. Reading `.key` off them yields undefined
      // and the spool silently appears empty while it is filling up.
      for (const object of page?.contents ?? []) {
        const key = object?.keyDetails?.key ?? object?.key;
        if (key) out.push(String(key));
      }
      continuationToken = page?.next_continuation_token ?? page?.next_token;
    } while (continuationToken && out.length < limit);
  } catch (err) {
    console.warn(`spool list failed: ${err.message}`);
    return [];
  }

  const entries = [];
  const stray = [];
  for (const key of out.slice(0, limit)) {
    try {
      const row = JSON.parse(await readBody(await bucket(catalystApp).getObject(key)));
      // Anything without the shape of an audit row is not one. Rendering it
      // would put a line of "undefined" into a security review.
      if (row && typeof row === 'object' && row.LOG_ID && row.OCCURRED_AT) {
        entries.push({ key, row });
      } else {
        stray.push(key);
      }
    } catch { /* a half-written or already-drained object is not fatal */ }
  }
  // Clear anything that is not an audit row so it cannot accumulate.
  if (stray.length) { try { await remove(catalystApp, stray); } catch { /* next pass */ } }

  entries.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return entries;
}

async function remove(catalystApp, keys) {
  if (!keys.length) return 0;
  try {
    await bucket(catalystApp).deleteObjects(keys.map((key) => ({ key })));
    return keys.length;
  } catch (err) {
    // Fall back to one at a time; a spool entry that cannot be deleted would
    // otherwise be inserted again on the next drain.
    let done = 0;
    for (const key of keys) {
      try { await bucket(catalystApp).deleteObject(key); done += 1; } catch { /* next drain retries */ }
    }
    return done;
  }
}

module.exports = { write, list, remove, BUCKET, PREFIX };
