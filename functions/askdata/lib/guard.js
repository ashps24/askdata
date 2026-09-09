'use strict';

/**
 * The guard: turns a *proposed* query into a *safe* one, or refuses it.
 *
 * Pure code, no LLM. Its verdict overrides the model's, always. Nothing that
 * reaches the read path is trusted because a model produced it, and nothing is
 * trusted because a prompt asked nicely.
 *
 * TWO OUTPUTS, DELIBERATELY DIFFERENT. A refusal carries
 *
 *   - `verdict`: technical, for `SupportQueryLog` and a security review
 *   - `reason` : plain English, for a support engineer who does not know SQL
 *
 * They are separate because the whole premise of AskData is that the engineer
 * never needs to read a query. A refusal that says "unbalanced parenthesis near
 * JOIN" is a failure of the tool. The engineer gets "I can't answer that
 * safely - try naming the module"; the reviewer gets the detail.
 *
 * ORG_ID IS INJECTED, NOT CHECKED. Verifying that the model remembered to scope
 * the query fails *open* the moment it forgets - the query runs across every
 * customer. Adding the predicate ourselves fails *closed*. It is injected
 * unconditionally, even when the model got it right, because trusting the model
 * to have got it right is the entire class of bug this prevents. The ORG_ID
 * comes from the grant, never from anything the caller sent.
 */

const { LIMITS } = require('./packs/types');

/** Verbs and constructs that must never appear. */
const WRITE_VERBS = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'REPLACE', 'MERGE', 'GRANT', 'REVOKE'];
const BANNED = ['UNION', 'INTO', 'EXEC', 'EXECUTE', 'CALL', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'OUTER JOIN'];

/** Words that can follow a table name but are not an alias. */
const NOT_AN_ALIAS = new Set([
  'ON', 'WHERE', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'JOIN',
  'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'AND', 'OR', 'AS', 'BY', 'USING', 'SET',
]);

const AGGREGATE = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i;

class Refused extends Error {
  constructor({ reason, verdict, security = false, suggestions = [] }) {
    super(reason);
    this.name = 'Refused';
    this.reason = reason;
    this.verdict = verdict;
    this.security = security;
    this.suggestions = suggestions;
  }
}

/* ------------------------------------------------------------------- lexing */

/**
 * Replace every '...' literal with a placeholder, so structural parsing cannot
 * be fooled by string contents. A quoted value holding the word JOIN, a
 * semicolon or an apostrophe can never be read as syntax.
 */
function maskLiterals(sql) {
  const literals = [];
  let out = '';
  let i = 0;

  while (i < sql.length) {
    if (sql[i] !== "'") { out += sql[i]; i++; continue; }
    let value = '';
    i++;
    let closed = false;
    while (i < sql.length) {
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") { value += "''"; i += 2; continue; }
        i++; closed = true; break;
      }
      value += sql[i]; i++;
    }
    if (!closed) {
      throw new Refused({
        reason: "I couldn't read that as a complete request. Try asking it in one sentence.",
        verdict: 'unterminated string literal',
      });
    }
    out += ` @${literals.length}@ `;
    literals.push(value);
  }
  return { masked: out, literals };
}

function unmask(masked, literals) {
  return masked.replace(/@(\d+)@/g, (_, n) => `'${literals[Number(n)]}'`);
}

function literalAt(token, literals) {
  const m = /^@(\d+)@$/.exec(String(token).trim());
  return m ? literals[Number(m[1])] : null;
}

/** Positions of a clause keyword at paren depth 0. */
function findClause(masked, pattern) {
  const re = new RegExp(pattern.source, 'gi');
  let depth = 0;
  const found = [];
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(masked);
      if (m && m.index === i) found.push({ index: i, length: m[0].length });
    }
  }
  return found;
}

/** Split a boolean expression into its top-level AND conjuncts. */
function splitConjuncts(expr) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const re = /\bAND\b/gi;
  let m;
  const marks = [];
  while ((m = re.exec(expr)) !== null) marks.push({ at: m.index, len: m[0].length });

  let markIdx = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')') depth = Math.max(0, depth - 1);
    while (markIdx < marks.length && marks[markIdx].at < i) markIdx++;
    if (depth === 0 && markIdx < marks.length && marks[markIdx].at === i) {
      parts.push(expr.slice(start, i));
      start = i + marks[markIdx].len;
      i = start - 1;
      markIdx++;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ compile */

/**
 * Compile a proposed query for one grant.
 *
 * `loaded` is the pack view from lib/packs (allow-list, PII, indexed columns).
 * Returns { zcql, tables, injected, limit, columnCount, hasAggregate }.
 * Throws `Refused` with both a plain reason and a technical verdict.
 */
function compile(proposed, orgId, loaded) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(orgId ?? ''))) {
    throw new Refused({ reason: 'Internal error: no customer is connected.', verdict: `bad org id: ${orgId}` });
  }
  if (typeof proposed !== 'string' || !proposed.trim()) {
    throw new Refused({ reason: "I couldn't work out a way to look that up.", verdict: 'empty query' });
  }

  // Comments go first: they can hide keywords from a reviewer while the engine
  // still sees what follows them.
  let sql = String(proposed)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;\s*$/, '')
    .trim();

  const { masked: masked0, literals } = maskLiterals(sql);
  let masked = masked0;

  /* --- one statement, and it reads ------------------------------------- */
  if (masked.includes(';')) {
    throw new Refused({ reason: "I can only look up one thing at a time.", verdict: 'multiple statements' });
  }

  for (const verb of WRITE_VERBS) {
    if (new RegExp(`\\b${verb}\\b`, 'i').test(masked)) {
      // A write verb means prompt injection or a bug. Both deserve an alert.
      throw new Refused({
        reason:
          'AskData only reads data - it can never change it. If the customer needs ' +
          'something changed, that has to go to a debug engineer.',
        verdict: `write verb ${verb}`,
        security: true,
      });
    }
  }
  if (!/^SELECT\b/i.test(masked)) {
    throw new Refused({
      reason: "I couldn't turn that into a lookup. Try naming the module - leads, contacts, deals, segments or departments.",
      verdict: 'statement does not begin with SELECT',
    });
  }
  for (const word of BANNED) {
    if (new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'i').test(masked)) {
      throw new Refused({
        reason: "That needs a kind of lookup I can't do safely. I can hand it to a debug engineer instead.",
        verdict: `banned construct ${word}`,
      });
    }
  }
  if ((masked.match(/\bSELECT\b/gi) ?? []).length !== 1 || /\(\s*SELECT\b/i.test(masked)) {
    throw new Refused({
      reason: "That question needs a nested lookup I can't do safely. I can hand it to a debug engineer instead.",
      verdict: 'subquery or multiple SELECT',
    });
  }
  if (/\bLIKE\b/i.test(masked)) {
    // Not style: ZCQL's LIKE matches nothing at all, so allowing it returns an
    // empty result that reads to a customer as a definite "there are none".
    throw new Refused({
      reason: "I can only match exact values, not partial ones. Try the full name or id.",
      verdict: 'LIKE unsupported by engine (matches nothing)',
    });
  }

  /* --- tables and joins ------------------------------------------------ */
  const joinKeywords = masked.match(/\bJOIN\b/gi) ?? [];
  if (joinKeywords.length > LIMITS.MAX_JOINS) {
    throw new Refused({
      reason: 'That question spans too many things at once. Try asking about one of them at a time.',
      verdict: `${joinKeywords.length} joins exceeds max ${LIMITS.MAX_JOINS}`,
    });
  }

  const refRe =
    /\b(?:FROM|((?:LEFT|INNER)(?:\s+OUTER)?)\s+JOIN|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;

  const refs = [];
  let rm;
  while ((rm = refRe.exec(masked)) !== null) {
    const outer = /LEFT/i.test(rm[1] ?? '');
    let alias = rm[3] ?? null;
    if (alias && NOT_AN_ALIAS.has(alias.toUpperCase())) alias = null;
    refs.push({ raw: rm[2], alias, outer });
  }
  if (!refs.length) {
    throw new Refused({
      reason: "I couldn't tell which records to look at. Try naming the module - leads, contacts, users or tickets.",
      verdict: 'no table in FROM',
    });
  }

  /** qualifier -> { table, outer } */
  const qualifiers = new Map();
  const tablesUsed = new Set();

  for (const ref of refs) {
    const canonical = loaded.resolveTableName(ref.raw);
    if (!canonical) {
      // Distinguish "no such table" from "that product is not subscribed" -
      // the second must be a refusal and never an empty result, because
      // "0 segments" reads as "you have none" rather than "you don't have
      // Campaigns".
      const inAnotherPack = require('./packs').ALL_TABLES.find(
        (t) => t.name.toLowerCase() === ref.raw.toLowerCase()
      );
      if (inAnotherPack && !inAnotherPack.internal) {
        throw new Refused({
          reason:
            `This customer isn't subscribed to ${inAnotherPack.pack === 'campaigns' ? 'Zoho Campaigns'
              : inAnotherPack.pack === 'desk' ? 'Zoho Desk' : inAnotherPack.pack}, ` +
            `so there is nothing to check there. Their products are: ${loaded.productKeys.join(', ') || 'none'}.`,
          verdict: `table ${inAnotherPack.name} belongs to unsubscribed pack ${inAnotherPack.pack}`,
          suggestions: loaded.tables.slice(0, 6).map((t) => `ask about ${t.label}`),
        });
      }
      throw new Refused({
        reason: "I don't have that kind of record. I can look at " +
          `${suggestibleLabels(loaded).join(', ')}.`,
        verdict: `unknown table ${ref.raw}`,
        suggestions: suggestibleLabels(loaded).map((l) => `ask about ${l}`),
      });
    }

    if (ref.raw !== canonical) {
      masked = masked.replace(
        new RegExp(`\\b(FROM|JOIN)(\\s+)${ref.raw}\\b`, 'gi'),
        (_, kw, ws) => `${kw}${ws}${canonical}`
      );
    }
    tablesUsed.add(canonical);
    qualifiers.set(ref.alias ?? canonical, { table: canonical, outer: ref.outer });
  }

  /* --- every join must run along a declared foreign key ---------------- */
  //
  // ZCQL refuses a join on two matching business-key columns ("No relationship
  // between tables"), so checking it here turns an opaque engine error into a
  // sentence, and stops the model inventing joins that cannot work.
  const onRe = /\bON\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/gi;
  let om;
  let onCount = 0;
  while ((om = onRe.exec(masked)) !== null) {
    onCount++;
    const [, lq, lc, rq, rc] = om;
    const pairs = [[lq, lc, rq, rc], [rq, rc, lq, lc]];
    const ok = pairs.some(([cq, cc, pq, pc]) => {
      const child = qualifiers.get(cq)?.table;
      const parent = qualifiers.get(pq)?.table;
      if (!child || !parent || pc.toUpperCase() !== 'ROWID') return false;
      const def = loaded.byTable.get(child);
      return (def?.refs ?? []).some((r) => r.column === cc.toUpperCase() && r.parent === parent);
    });
    if (!ok) {
      throw new Refused({
        reason: "I can't connect those two things together. I can hand this to a debug engineer.",
        verdict: `join ${lq}.${lc} = ${rq}.${rc} is not a declared foreign key`,
      });
    }
  }
  if (onCount !== joinKeywords.length) {
    throw new Refused({
      reason: "I couldn't work out how those records relate. I can hand this to a debug engineer.",
      verdict: `${joinKeywords.length} joins but ${onCount} usable ON conditions`,
    });
  }

  /* --- columns exist, and count is within limits ----------------------- */
  const selectEnd = findClause(masked, /FROM\b/)[0]?.index ?? masked.length;
  const selectList = masked.slice(6, selectEnd).trim();
  // `*` is not 20 columns of its own; count what the widest table actually has,
  // so a legitimate `SELECT *` on a narrow table is not refused for the wrong reason.
  const starCount = () => Math.max(
    ...[...tablesUsed].map((t) => (loaded.byTable.get(t)?.columnNames.length ?? 0) + 4), 0);
  const columnCount = /^\*$/.test(selectList) ? starCount() : splitTopLevel(selectList).length;
  if (columnCount > LIMITS.MAX_COLUMNS) {
    throw new Refused({
      reason: 'That would return too many fields at once. Try asking for the specific ones you need.',
      verdict: `${columnCount} columns exceeds max ${LIMITS.MAX_COLUMNS}`,
    });
  }

  const qualRe = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let qm;
  const systemCols = new Set(['ROWID', 'CREATEDTIME', 'MODIFIEDTIME', 'CREATORID']);
  while ((qm = qualRe.exec(masked)) !== null) {
    const [, qual, col] = qm;
    const table = qualifiers.get(qual)?.table;
    if (!table || col === '*') continue;
    const def = loaded.byTable.get(table);
    if (!def) continue;
    if (!def.columnNames.includes(col.toUpperCase()) && !systemCols.has(col.toUpperCase())) {
      throw new Refused({
        reason: `${def.label} don't have a "${col.toLowerCase().replace(/_/g, ' ')}" field. ` +
          'Try naming a field you can see in the results.',
        verdict: `unknown column ${table}.${col}`,
      });
    }
  }

  const hasAggregate = AGGREGATE.test(masked);
  const hasGroupBy = findClause(masked, /GROUP\s+BY\b/).length > 0;

  /* --- strip any ORG_ID predicate the model wrote ---------------------- */
  const wheres = findClause(masked, /WHERE\b/);
  if (wheres.length > 1) {
    throw new Refused({ reason: "I couldn't read that request.", verdict: 'multiple WHERE clauses' });
  }

  const tail = [
    ...findClause(masked, /GROUP\s+BY\b/),
    ...findClause(masked, /HAVING\b/),
    ...findClause(masked, /ORDER\s+BY\b/),
    ...findClause(masked, /LIMIT\b/),
  ].sort((a, b) => a.index - b.index);

  let userWhere = '';
  let whereStart = -1;
  let whereEnd = -1;
  if (wheres.length === 1) {
    whereStart = wheres[0].index;
    whereEnd = tail.find((t) => t.index > whereStart)?.index ?? masked.length;
    userWhere = masked.slice(whereStart + wheres[0].length, whereEnd).trim();
  }

  let strippedOrgPredicate = false;
  if (userWhere) {
    const kept = [];
    for (const conjunct of splitConjuncts(userWhere)) {
      if (!/\bORG_ID\b/i.test(conjunct)) { kept.push(conjunct); continue; }

      // A lone `X.ORG_ID = 'value'` conjunct is safe to drop. One tangled up
      // in an OR is not - dropping it would widen the surrounding condition,
      // and rewriting it in place could quietly change the filter's meaning.
      // Refuse instead; our own scope is injected either way, so this costs a
      // retry rather than a tenancy hole.
      if (/^\(?\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?ORG_ID\s*(?:=|!=|<>)\s*@\d+@\s*\)?$/i.test(conjunct)) {
        strippedOrgPredicate = true;
        continue;
      }
      throw new Refused({
        reason: "I couldn't safely narrow that to this customer. Try asking it more simply.",
        verdict: `ORG_ID predicate not a simple conjunct: ${conjunct.trim()}`,
        security: true,
      });
    }
    userWhere = kept.join(' AND ').trim();
  }

  /* --- PII dump protection --------------------------------------------- */
  if (!hasAggregate) {
    for (const [qual, { table }] of qualifiers) {
      const piiCols = loaded.pii[table];
      if (!piiCols) continue;
      const selectsStar = /\*/.test(selectList);
      const selectsPii = Object.keys(piiCols).some((c) =>
        new RegExp(`(?:\\b${qual}\\.)?\\b${c}\\b`, 'i').test(selectList));
      if ((selectsStar || selectsPii) && !userWhere) {
        throw new Refused({
          reason:
            "That would pull the whole contact list, which I can't do. " +
            'Ask about a specific record, or ask for a count instead.',
          verdict: `unfiltered PII selection from ${table}`,
          security: true,
          suggestions: ['ask for a count, e.g. "how many contacts are there"'],
        });
      }
    }
  }

  /* --- replica protection: the filter must be able to use an index ----- */
  //
  // Checked on the model's own WHERE, before injection: ORG_ID is indexed, so
  // afterwards every query would pass and the rule would be worthless.
  if (!hasAggregate && !hasGroupBy) {
    const touched = [];
    for (const [qual, { table }] of qualifiers) {
      const def = loaded.byTable.get(table);
      for (const col of def?.filterable ?? []) {
        if (col === 'ORG_ID') continue;
        const re = new RegExp(`(?:\\b${qual}\\.)?\\b${col}\\b`, 'i');
        if (re.test(userWhere)) touched.push(`${table}.${col}`);
      }
    }
    if (!touched.length) {
      throw new Refused({
        reason:
          'That would look at every record in the account, which is too broad. ' +
          'Narrow it down - a record id, a name, a status, or a date range.',
        verdict: userWhere
          ? `WHERE touches no indexed column: ${userWhere.slice(0, 120)}`
          : 'no WHERE and no aggregate',
        suggestions: [
          'add an id, e.g. "lead 4551000000234017"',
          'or ask for a count, e.g. "how many leads do we have"',
        ],
      });
    }
  }

  /* --- inject scope ---------------------------------------------------- */
  //
  // An OUTER-joined table cannot take a plain equality: `x.ORG_ID = '...'` is
  // false for every unmatched row, which silently demotes the LEFT JOIN to an
  // INNER one and deletes exactly the rows an outer join exists to find. The
  // predicate becomes "belongs to this tenant, or there is no joined row".
  const conjuncts = [...qualifiers.entries()].map(([qual, { outer }]) =>
    outer
      ? `(${qual}.ORG_ID = '${orgId}' OR ${qual}.ROWID IS NULL)`
      : `${qual}.ORG_ID = '${orgId}'`);
  const scope = conjuncts.join(' AND ');

  let rebuilt;
  const insertAt = tail.length ? tail[0].index : masked.length;
  if (wheres.length === 1) {
    const head = masked.slice(0, whereStart);
    const rest = masked.slice(whereEnd);
    rebuilt = userWhere
      ? `${head}WHERE (${userWhere}) AND ${scope} ${rest}`
      : `${head}WHERE ${scope} ${rest}`;
  } else {
    rebuilt = `${masked.slice(0, insertAt).trimEnd()} WHERE ${scope} ${masked.slice(insertAt)}`;
  }

  /* --- row cap ---------------------------------------------------------- */
  let limit;
  const limitRe = /\bLIMIT\s+(\d+)(?:\s*,\s*(\d+))?\s*$/i;
  const lm = limitRe.exec(rebuilt.trim());
  if (lm) {
    const hasOffset = lm[2] !== undefined;
    const offset = hasOffset ? Number(lm[1]) : 0;
    const count = Math.min(Number(hasOffset ? lm[2] : lm[1]), LIMITS.MAX_ROWS);
    limit = { offset, count };
    rebuilt = rebuilt.trim().replace(limitRe, `LIMIT ${offset}, ${count}`);
  } else {
    limit = { offset: 0, count: LIMITS.DEFAULT_LIMIT };
    rebuilt = `${rebuilt.trim()} LIMIT 0, ${LIMITS.DEFAULT_LIMIT}`;
  }

  const zcql = unmask(rebuilt, literals).replace(/\s+/g, ' ').trim();

  return {
    zcql,
    tables: [...tablesUsed],
    qualifiers: Object.fromEntries([...qualifiers].map(([k, v]) => [k, v.table])),
    injected: scope,
    limit,
    columnCount,
    hasAggregate,
    strippedOrgPredicate,
    verdict: `pass: ${tablesUsed.size} table(s), ${joinKeywords.length} join(s)` +
      `${strippedOrgPredicate ? ', stripped model ORG_ID' : ''}, scope injected`,
  };
}

/**
 * Short, readable names for what this org's packs can answer about.
 * Product tables lead, because "leads" and "tickets" are the words a support
 * engineer types; the platform labels are descriptive sentences and read badly
 * in a list.
 */
function suggestibleLabels(loaded) {
  const product = loaded.tables.filter((t) => t.pack !== 'platform').map((t) => t.label);
  return [...new Set([...product.slice(0, 6), 'users', 'profiles'])];
}

/** Split a select list on top-level commas. */
function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth = Math.max(0, depth - 1);
    else if (list[i] === ',' && depth === 0) { parts.push(list.slice(start, i)); start = i + 1; }
  }
  parts.push(list.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

module.exports = { compile, Refused, maskLiterals, splitConjuncts, splitTopLevel };
