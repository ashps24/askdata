/**
 * Dump the generated sample dataset as JSON, for the Excel workbook and for
 * anyone who wants to load it somewhere other than Catalyst.
 *
 *   node scripts/export-dataset.mjs [--audit-per-org 60] > dataset.json
 *
 * The seeder is the single source of truth: the workbook and the Data Store
 * therefore cannot disagree about what the sample data is.
 */

import { createRequire } from 'node:module';
const require = createRequire('/Users/ashwin-4104/askdata/functions/askdata/');
const seed = require('./lib/seed');
const packs = require('./lib/packs');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

seed.AUDIT_PER_ORG.value = Number(arg('audit-per-org', 60));

const tables = {};
for (const build of Object.values(seed.STAGES)) Object.assign(tables, build());

// Column order comes from the packs, so a sheet reads like the table does.
const columnsFor = (name) => {
  const table = packs.ALL_TABLES.find((t) => t.name === name);
  return table ? table.columns.map((c) => c.name) : Object.keys(tables[name][0] ?? {});
};

process.stdout.write(JSON.stringify({
  generated_at: new Date().toISOString(),
  companies: seed.ORGS.map((o) => ({
    ORG_ID: o.ORG_ID, ORG_NAME: o.ORG_NAME, DC: o.DC, EDITION: o.EDITION,
    SUBSCRIBED_PRODUCTS: o.SUBSCRIBED_PRODUCTS, SIGNED_UP_ON: o.SIGNED_UP_ON,
    CRM_ORG_ID: o.CRM_ORG_ID, CMP_ORG_ID: o.CMP_ORG_ID, DESK_ORG_ID: o.DESK_ORG_ID,
    OPEN_TICKET: `TKT-${o.ZGID.slice(-4)}`,
  })),
  pii: Object.fromEntries(packs.ALL_TABLES.map((t) => [t.name, t.piiColumns ?? []])),
  columns: Object.fromEntries(Object.keys(tables).map((n) => [n, columnsFor(n)])),
  tables,
}, null, 1));
