'use strict';

/**
 * The pack registry.
 *
 * Adding Zoho Projects means writing `projects.js` and adding one line to
 * `ALL` below. Nothing else in the app names a product.
 *
 * The engine loads only the packs the connected org has subscribed to, and that
 * is an accuracy decision as much as a tidiness one: a schema card listing 200
 * tables across 15 products produces measurably worse ZCQL than one listing the
 * 14 tables of the two products this customer actually uses. It is also a
 * correctness boundary - a question about Campaigns asked against an org with no
 * Campaigns subscription must be REFUSED, not answered "0 segments", because
 * "0" reads to a customer as "you have none" rather than "you do not have this
 * product".
 */

const { normalisePack, LIMITS } = require('./types');

const ALL = [
  require('./platform'),
  require('./crm'),
  require('./campaigns'),
  require('./desk'),
].map(normalisePack);

const BY_KEY = new Map(ALL.map((p) => [p.key, p]));

/** Packs that load for every org regardless of subscription. */
const ALWAYS = ALL.filter((p) => p.always);

/** Every table across every pack - used only by provisioning and the seeder. */
const ALL_TABLES = ALL.flatMap((p) => p.tables);

/** Parse `SUBSCRIBED_PRODUCTS` and return the packs, always plus subscribed. */
function packsFor(subscribedProducts) {
  const keys = String(subscribedProducts ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const chosen = [...ALWAYS];
  for (const key of keys) {
    const pack = BY_KEY.get(key);
    if (pack && !chosen.includes(pack)) chosen.push(pack);
  }
  return chosen;
}

/**
 * A resolved view of the loaded packs: everything the guard, the prompt and the
 * masker need, already merged, so none of them iterates packs itself.
 */
function loadedView(packs) {
  const tables = packs.flatMap((p) => p.tables);
  const queryable = tables.filter((t) => !t.internal);

  const byTable = new Map(tables.map((t) => [t.name, t]));

  // Case-insensitive lookup, so a model that lowercases a table name is
  // corrected rather than refused.
  const byLower = new Map(queryable.map((t) => [t.name.toLowerCase(), t.name]));

  const pii = {};
  for (const t of queryable) {
    if (Object.keys(t.piiColumns).length) pii[t.name] = t.piiColumns;
  }

  const synonyms = {};
  for (const p of packs) Object.assign(synonyms, p.synonyms ?? {});

  return {
    packs,
    packKeys: packs.map((p) => p.key),
    productKeys: packs.filter((p) => !p.always).map((p) => p.key),
    tables: queryable,
    allTables: tables,
    tableNames: queryable.map((t) => t.name),
    byTable,
    resolveTableName: (name) => byLower.get(String(name ?? '').toLowerCase()) ?? null,
    pii,
    synonyms,
    commonQuestions: packs.flatMap((p) => p.commonQuestions ?? []),
    limits: LIMITS,
  };
}

/** Convenience: packs for an Orgs row. */
function forOrg(org) {
  return loadedView(packsFor(org?.SUBSCRIBED_PRODUCTS));
}

/** Every pack, for provisioning. */
function everything() {
  return loadedView(ALL);
}

module.exports = { ALL, BY_KEY, ALL_TABLES, packsFor, loadedView, forOrg, everything, LIMITS };
