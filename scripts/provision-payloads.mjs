/**
 * Emit the Catalyst MCP payloads that create AskData's tables.
 *
 *   node scripts/provision-payloads.mjs            # summary
 *   node scripts/provision-payloads.mjs --json     # the payloads themselves
 *
 * The packs are the single source of truth, so the schema in the Data Store and
 * the schema the guard enforces cannot drift apart.
 *
 * Three Data Store traps are handled here rather than discovered per table:
 *
 *   1. a `boolean` column REQUIRES `default_value`. Without it the whole batch
 *      fails with a bare PATTERN_NOT_MATCHED naming neither column nor field.
 *   2. the `description` property rejects `|`, `;` and `=` with the same
 *      unhelpful error, so descriptions are stripped to safe punctuation.
 *   3. `PRIORITY` and `RESULT` are reserved column names. The packs already
 *      avoid them (DESK_Tickets.TICKET_PRIORITY, AuditEvents.OUTCOME); this
 *      asserts it rather than trusting it.
 *
 * Foreign keys need the parent's ROWID column id, which only exists after the
 * parent table is created - so refs are emitted as a second phase.
 */

import { createRequire } from 'node:module';
const require = createRequire('/Users/ashwin-4104/askdata/functions/askdata/');
const packs = require('./lib/packs');

const RESERVED = ['PRIORITY', 'RESULT'];

/** Description text Data Store will accept: no | ; = characters. */
function safeDescription(text) {
  if (!text) return undefined;
  const clean = String(text)
    .replace(/[|;=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return clean || undefined;
}

function columnPayload(c) {
  const p = {
    column_name: c.name,
    data_type: c.type,
    is_mandatory: c.mandatory ? 'true' : 'false',
    audit_consent: 'false',
  };

  // `text` accepts neither is_unique nor search_index_enabled.
  if (c.type !== 'text') {
    p.search_index_enabled = 'false';
    if (!['boolean', 'date', 'datetime', 'double'].includes(c.type)) {
      p.is_unique = c.unique ? 'true' : 'false';
    }
  }
  if (c.type === 'varchar') p.max_length = c.max_length ?? 160;
  if (c.type === 'double') p.decimal_digits = c.decimal_digits ?? 2;

  // Trap 1: boolean without a default fails the entire batch.
  if (c.type === 'boolean') p.default_value = c.default_value ?? 'false';

  const parts = [];
  if (c.describe) parts.push(c.describe);
  if (c.values) parts.push(`one of ${c.values.join(' or ')}`);
  if (c.pii) parts.push(`PII, masked on output as a ${c.pii}`);
  const desc = safeDescription(parts.join('. '));
  if (desc) p.description = desc;

  return p;
}

const tables = packs.ALL_TABLES;
const problems = [];

for (const t of tables) {
  for (const c of t.columns) {
    if (RESERVED.includes(c.name.toUpperCase())) {
      problems.push(`${t.name}.${c.name} is a reserved column name`);
    }
    if (['ROWID', 'CREATEDTIME', 'MODIFIEDTIME', 'CREATORID'].includes(c.name.toUpperCase())) {
      problems.push(`${t.name}.${c.name} redefines a system column`);
    }
  }
  if (!t.columns.some((c) => c.name === 'ORG_ID')) {
    problems.push(`${t.name} has no ORG_ID - the tenant boundary is never optional`);
  }
}

const payloads = {
  tables: tables.map((t) => ({ table_name: t.name, table_scope: 'GLOBAL' })),
  columns: Object.fromEntries(tables.map((t) => [t.name, t.columns.map(columnPayload)])),
  refs: tables.flatMap((t) =>
    t.refs.map((r) => ({
      table: t.name,
      column_name: r.column,
      data_type: 'foreign key',
      parent: r.parent,
      mirrors: r.from,
      constraint_type: r.onDelete ?? 'ON-DELETE-SET-NULL',
      is_mandatory: 'false',
      search_index_enabled: 'false',
      audit_consent: 'false',
      description: safeDescription(`Foreign key to ${r.parent} ROWID, mirrors ${r.from}`),
    }))),
};

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(payloads, null, 2));
} else {
  console.log(`tables : ${payloads.tables.length}`);
  console.log(`columns: ${Object.values(payloads.columns).reduce((n, c) => n + c.length, 0)}`);
  console.log(`refs   : ${payloads.refs.length}`);
  console.log(`booleans with a default: ${
    Object.values(payloads.columns).flat().filter((c) => c.data_type === 'boolean' && c.default_value).length
  }/${Object.values(payloads.columns).flat().filter((c) => c.data_type === 'boolean').length}`);
  console.log(`descriptions carrying | ; or = : ${
    Object.values(payloads.columns).flat().filter((c) => /[|;=]/.test(c.description ?? '')).length
  }  (must be 0)`);
  console.log(problems.length ? `\nPROBLEMS:\n  ${problems.join('\n  ')}` : '\nno schema problems');
  console.log('\nper table:');
  for (const t of tables) {
    console.log(`  ${t.name.padEnd(24)} ${String(t.columns.length).padStart(2)} cols  ${t.refs.length} refs${t.internal ? '   [internal]' : ''}`);
  }
}
