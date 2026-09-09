'use strict';

/**
 * The shape of a product pack, and the helpers every pack is read through.
 *
 * A pack is self-describing so that adding Zoho Projects later means dropping a
 * file into this directory, not editing the engine. Nothing outside
 * `lib/packs/` knows the name of any product.
 *
 * One pack file declares tables, synonyms, PII columns and few-shot questions.
 * Five separate consumers read those declarations, and they must not be allowed
 * to drift apart:
 *
 *   1. provisioning  - the column definitions sent to the Data Store
 *   2. the guard     - the table allow-list, PII flags, filterable columns
 *   3. the prompt    - the schema card the model sees
 *   4. masking       - which columns are redacted on the way out
 *   5. the seeder    - what shape of row to generate
 *
 * COLUMN NAMING. Business keys (`USER_ID`, `PROFILE_ID`) are what support
 * engineers and customers say out loud, so they stay. But ZCQL will only join
 * along a declared foreign key, in the form `child.X_REF = Parent.ROWID` - a
 * join written on two matching business-key columns is refused outright with
 * "No relationship between tables". So every join in this app needs a `_REF`
 * column declared in `refs`, carrying the parent's platform-assigned ROWID.
 * `lib/provision.js` creates them and the seeder fills them in.
 *
 * RESERVED NAMES. Data Store refuses `PRIORITY` and `RESULT` as column names.
 * The spec's `DESK_Tickets.PRIORITY` is therefore `TICKET_PRIORITY` here, and
 * every pack declares `askedAs` on such a column so the prompt can teach the
 * model the word a person will actually use.
 */

/** PII kinds, and how each renders when masked. See lib/mask.js. */
const PII_KINDS = ['email', 'phone', 'name'];

/** Column types this app uses, mapped to Data Store types. */
const TYPES = ['varchar', 'text', 'int', 'bigint', 'double', 'boolean', 'date', 'datetime'];

/**
 * Normalise a table declaration.
 *
 * Fills in the derived views every consumer wants, so no consumer has to walk
 * the column list itself and get the PII test subtly wrong.
 */
function normaliseTable(pack, table) {
  const columns = table.columns.map((c) => ({ ...c }));
  const refs = (table.refs ?? []).map((r) => ({ ...r }));

  return {
    ...table,
    pack: pack.key,
    columns,
    refs,
    /** Business columns plus the ref columns, which are real and queryable. */
    columnNames: [...columns.map((c) => c.name), ...refs.map((r) => r.column)],
    /** `{ COLUMN: 'email' }` for every PII column on this table. */
    piiColumns: Object.fromEntries(
      columns.filter((c) => c.pii).map((c) => [c.name, c.pii])
    ),
    /** Columns a WHERE clause may filter on without scanning the table. */
    filterable: columns.filter((c) => c.indexed).map((c) => c.name),
  };
}

/** Normalise a whole pack. */
function normalisePack(pack) {
  const tables = pack.tables.map((t) => normaliseTable(pack, t));
  return {
    ...pack,
    tables,
    tableNames: tables.map((t) => t.name),
    byTable: new Map(tables.map((t) => [t.name, t])),
  };
}

/** Every ZCQL type/constraint limit the guard enforces, in one place. */
const LIMITS = {
  MAX_JOINS: 4,
  MAX_ROWS: 300,
  MAX_COLUMNS: 20,
  DEFAULT_LIMIT: 200,
};

module.exports = { PII_KINDS, TYPES, LIMITS, normalisePack, normaliseTable };
