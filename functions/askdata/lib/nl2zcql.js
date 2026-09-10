'use strict';

/**
 * Question -> proposed ZCQL.
 *
 * The model writes a query; it never sees a row of customer data and never
 * states a fact. The guard decides whether what it wrote may run, and
 * lib/answer.js writes every sentence from the rows themselves. That division
 * is deliberate: a model is genuinely good at turning "can you check whether
 * Ashwin exported anything" into a four-table join, and genuinely unreliable at
 * asserting what the join returned.
 *
 * The schema card is built from the LOADED packs only. A card listing 200 tables
 * across 15 products produces measurably worse ZCQL than one listing the 14
 * tables of the two products this customer actually has.
 *
 * TIMEOUT IS NOT OPTIONAL. Advanced I/O has a hard 30-second ceiling and the
 * platform returns 408 while the handler keeps running past it. The model call
 * is aborted well inside that, and a timeout is a `clarify`, not a crash.
 */

const { chat } = require('./llm');

const MODEL_TIMEOUT_MS = Number(process.env.ASKDATA_MODEL_TIMEOUT_MS || 12000);
const CONFIDENCE_FLOOR = Number(process.env.ASKDATA_CONFIDENCE_FLOOR || 0.6);

/** The engine's real limits, stated as rules because breaking them fails silently. */
const ENGINE_RULES = [
  'Produce exactly one SELECT statement. Never INSERT, UPDATE or DELETE - this tool is read-only.',
  'Never write a subquery, UNION, CTE or window function. None are supported.',
  'At most 4 joins, and only INNER JOIN or LEFT JOIN.',
  'Exactly one condition per join, and a join must use a declared foreign key, always in',
  '  the form child.SOMETHING_REF = Parent.ROWID. Joining two id columns that merely hold',
  '  the same value (for example CRM_ExportJobs.USER_ID = Users.USER_ID) is rejected by the',
  '  engine, so use the _REF column listed under JOINS below.',
  'Never write LIKE and never use % wildcards - LIKE matches nothing in this engine.',
  'Use = with an exact value, or IN with a list of exact values.',
  'Do not filter on ORG_ID. Tenant scoping is applied automatically afterwards and any',
  '  ORG_ID you write is stripped.',
  'Boolean columns compare as the strings \'true\' and \'false\'.',
  'ORDER BY cannot reference an aggregate alias - repeat the expression, e.g.',
  '  ORDER BY COUNT(ROWID) DESC. Aliases on aggregates are discarded by the engine.',
  'Never use COUNT(DISTINCT x) - the DISTINCT is ignored and it counts rows instead.',
  'Table and column names are case-sensitive. Copy them exactly as written below.',
  'At most 20 columns. Name the columns a reader needs rather than using SELECT *.',
  'A WHERE clause must filter on at least one indexed column (marked * below), unless the',
  '  query is a COUNT/SUM/GROUP BY over the whole module.',
];

/** The schema card: only the loaded packs, with indexes and PII marked. */
function schemaCard(loaded) {
  const lines = [];

  for (const pack of loaded.packs) {
    const tables = pack.tables.filter((t) => !t.internal);
    if (!tables.length) continue;
    lines.push(`## ${pack.label}`);
    for (const t of tables) {
      lines.push(`TABLE ${t.name}  -- ${t.label}: ${String(t.describes).replace(/\s+/g, ' ')}`);
      for (const c of t.columns) {
        const bits = [c.type];
        if (c.indexed) bits.push('indexed*');
        if (c.pii) bits.push('PII, masked in output');
        if (c.values) bits.push(`one of ${c.values.map((v) => `'${v}'`).join('|')}`);
        if (c.askedAs) bits.push(`people call this "${c.askedAs}"`);
        if (c.describe) bits.push(c.describe);
        lines.push(`  ${c.name}: ${bits.join('; ')}`);
      }
      for (const r of t.refs) {
        lines.push(`  ${r.column}: foreign key -> ${r.parent}.ROWID (mirrors ${r.from})`);
      }
      lines.push('');
    }
  }

  lines.push('## JOINS - the only ones the engine accepts');
  for (const t of loaded.tables) {
    for (const r of t.refs) {
      lines.push(`  ${t.name}.${r.column} = ${r.parent}.ROWID`);
    }
  }

  return lines.join('\n');
}

/** How support engineers and customers actually word things. */
function synonymCard(loaded) {
  const entries = Object.entries(loaded.synonyms ?? {});
  if (!entries.length) return '';
  return ['## How people phrase things', ...entries.map(([k, v]) => `  "${k}" may be said as: ${v.join(', ')}`)].join('\n');
}

function systemPrompt(loaded) {
  return [
    'You translate a Zoho support engineer\'s question into a single read-only ZCQL query',
    'against one customer organization\'s data.',
    '',
    'Rules:',
    ...ENGINE_RULES.map((r) => `- ${r}`),
    '',
    'Answer with strict JSON and nothing else:',
    '{"intent":"read"|"clarify"|"refuse","zcql":"...","explanation":"...","clarify_question":"...","confidence":0.0}',
    '',
    '- intent "read" with a query when you can answer it.',
    '- intent "clarify" when the question does not name a module or a record, or is too vague',
    '  to turn into one query. Put a concrete question in clarify_question.',
    '- intent "refuse" when it asks to change data, or asks for something outside this schema.',
    '- confidence is your own 0-1 estimate that the query answers the question asked.',
    '',
    `The customer's products: ${loaded.productKeys.join(', ') || 'none'}.`,
    ...(loaded.serviceKey && loaded.serviceKey !== 'all'
      ? [
        `THIS SESSION IS SCOPED TO ONE SERVICE: ${loaded.serviceKey}. Profiles, UserProfiles, ` +
        `Permissions and AuditEvents hold rows for every product; a question about ` +
        `permissions, profiles or activity means ${loaded.serviceKey}'s only. Always add ` +
        `PRODUCT = '${loaded.serviceKey}' when you read those tables, and never answer about another product.`,
      ]
      : []),
    'Only the tables below exist. A table from a product not listed must be refused,',
    'not queried - answering "0 rows" would read to the customer as "you have none".',
    '',
    schemaCard(loaded),
    '',
    synonymCard(loaded),
  ].filter(Boolean).join('\n');
}

/** Worked examples from the loaded packs - cheap, and they fix the shapes. */
function fewShot(loaded) {
  const msgs = [];
  for (const ex of loaded.commonQuestions.slice(0, 8)) {
    msgs.push({ role: 'user', content: ex.q });
    msgs.push({
      role: 'assistant',
      content: JSON.stringify({
        intent: 'read', zcql: ex.zcql, explanation: '', clarify_question: '', confidence: 0.95,
      }),
    });
  }
  return msgs;
}

/** Pull a JSON object out of a model reply that may be wrapped in prose. */
function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const tries = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) tries.push(fence[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) tries.push(text.slice(first, last + 1));

  for (const t of tries) {
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* next */ }
  }
  return null;
}

/**
 * Ask the model. Returns the parsed decision, or throws.
 * Never falls back itself - the caller decides, so the reason stays visible.
 */
async function translate(catalystApp, { question, loaded, history = [], person = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    // The model cannot search for a name - LIKE is dead - so the caller resolves
    // who was meant and hands over the exact stored spelling, the only form
    // that will match.
    const hint = person
      ? `\n\nThe person referred to is stored with FULL_NAME exactly '${person.FULL_NAME}' ` +
        `and USER_ID '${person.USER_ID}'. Filter on one of those exact values.`
      : '';

    const turns = history
      .slice(-3)
      .flatMap((h) => [
        { role: 'user', content: String(h.question ?? '').slice(0, 400) },
        { role: 'assistant', content: String(h.zcql ?? h.summary ?? '').slice(0, 400) },
      ])
      .filter((m) => m.content);

    const raw = await chat(
      catalystApp,
      [
        { role: 'system', content: systemPrompt(loaded) },
        ...fewShot(loaded),
        ...turns,
        { role: 'user', content: `${String(question).slice(0, 1000)}${hint}` },
      ],
      { maxTokens: 600, temperature: 0, signal: controller.signal }
    );

    const parsed = extractJson(raw);
    if (!parsed) {
      const err = new Error('The model did not return usable JSON.');
      err.raw = String(raw).slice(0, 500);
      throw err;
    }

    return {
      intent: ['read', 'clarify', 'refuse'].includes(parsed.intent) ? parsed.intent : 'clarify',
      zcql: typeof parsed.zcql === 'string' ? parsed.zcql.trim() : '',
      explanation: String(parsed.explanation ?? '').slice(0, 500),
      clarify_question: String(parsed.clarify_question ?? '').slice(0, 300),
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
      raw: String(raw).slice(0, 1000),
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`The model did not respond within ${MODEL_TIMEOUT_MS}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { translate, systemPrompt, schemaCard, synonymCard, extractJson, MODEL_TIMEOUT_MS, CONFIDENCE_FLOOR, ENGINE_RULES };
