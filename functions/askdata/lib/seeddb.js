'use strict';

/**
 * An in-memory database built from the seed generators, with a ZCQL evaluator
 * for the queries the guard produces.
 *
 * WHY THIS EXISTS
 *
 * The Data Store insert AND bulk-write allowances are exhausted for the whole
 * org - verified by probing two other projects - so no sample row can be
 * written anywhere until a payment method is added. That left a test app whose
 * tables were correct and empty, which reads as dead. The seed generators
 * already produce every row for every table for all ten companies,
 * deterministically. So this serves them directly.
 *
 * lib/replica.js was written as "the single seam a real client would replace".
 * This is that replacement for a test deployment. Nothing above it changes:
 * the guard still compiles and scopes the ZCQL, masking still runs after, the
 * audit still writes. Only the executor differs. When the Data Store is
 * writable again, load the same rows there and set ASKDATA_DATA_SOURCE back
 * to datastore - answers will not change, because it is the same data.
 *
 * WHAT IT EVALUATES
 *
 * Exactly the grammar the guard lets through, and no more:
 *
 *   SELECT a.B, COUNT(ROWID), COUNT(a.B), SUM(a.B)
 *   FROM T [INNER|LEFT JOIN T2 ON T.X_REF = T2.ROWID]...
 *   WHERE <expr>   with AND OR NOT ( ) = <> != < <= > >= IS [NOT] NULL
 *   GROUP BY a.B   ORDER BY a.B|COUNT(..)|SUM(..) [ASC|DESC]   LIMIT off, n
 *
 * ROWIDs are synthesised deterministically from (table, ORG_ID, position) so
 * they are stable across invocations, and every _REF column is resolved to its
 * parent's ROWID the way /admin/provision-refs does against the real store.
 */

const seed = require('./seed');
const packs = require('./packs');

/* --------------------------------------------------------------- build */

let cache = null;

function rowidFor(table, row, index) {
  // Deterministic, looks like a Catalyst ROWID, and includes the table name in
  // the hash so two tables never mint the same id.
  const key = `${table}|${row.ORG_ID}|${index}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return String(30663000000000000 + (h % 999999999));
}

function build() {
  if (cache) return cache;
  seed.AUDIT_PER_ORG.value = Number(process.env.ASKDATA_SEED_AUDIT_PER_ORG || 60);

  const tables = {};
  for (const buildStage of Object.values(seed.STAGES)) {
    for (const [name, rows] of Object.entries(buildStage())) tables[name] = (tables[name] ?? []).concat(rows);
  }

  for (const [name, rows] of Object.entries(tables)) {
    rows.forEach((r, i) => { r.ROWID = rowidFor(name, r, i); });
  }

  // _REF columns: (ORG_ID, business key) -> parent ROWID
  const keyColumn = (tableName) => {
    const def = packs.ALL_TABLES.find((t) => t.name === tableName);
    return def?.columns.find((c) => c.name.endsWith('_ID') && c.name !== 'ORG_ID')?.name;
  };
  for (const def of packs.ALL_TABLES) {
    const rows = tables[def.name]; if (!rows) continue;
    for (const ref of def.refs ?? []) {
      const pk = keyColumn(ref.parent);
      const index = new Map((tables[ref.parent] ?? []).map((p) => [`${p.ORG_ID}|${p[pk]}`, p.ROWID]));
      for (const r of rows) r[ref.column] = r[ref.from] ? (index.get(`${r.ORG_ID}|${r[ref.from]}`) ?? null) : null;
    }
  }

  cache = tables;
  return cache;
}

function tableRows(name) {
  const t = build();
  const key = Object.keys(t).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return key ? t[key] : [];
}

/* ------------------------------------------------------------- tokenise */

function tokenise(sql) {
  const out = [];
  const re = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_*]*)?)|(<>|!=|<=|>=|=|<|>|\(|\)|,|\*))/y;
  let pos = 0;
  while (pos < sql.length) {
    re.lastIndex = pos;
    const m = re.exec(sql);
    if (!m) { if (/^\s*$/.test(sql.slice(pos))) break; throw new Error(`seeddb: cannot tokenise near "${sql.slice(pos, pos + 20)}"`); }
    pos = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: 'str', v: m[1].slice(1, -1).replace(/''/g, "'") });
    else if (m[2] !== undefined) out.push({ t: 'num', v: Number(m[2]) });
    else if (m[3] !== undefined) out.push({ t: 'id', v: m[3] });
    else if (m[4] !== undefined) out.push({ t: 'op', v: m[4] });
    else break;
  }
  return out;
}

/* ---------------------------------------------------------------- parse */

function parse(sql) {
  const toks = tokenise(sql);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const isKw = (w) => peek() && peek().t === 'id' && peek().v.toUpperCase() === w;
  const expectKw = (w) => { if (!isKw(w)) throw new Error(`seeddb: expected ${w} near ${JSON.stringify(peek())}`); next(); };
  const isOp = (o) => peek() && peek().t === 'op' && peek().v === o;

  expectKw('SELECT');
  const select = [];
  do {
    const tok = next();
    if (tok.t === 'id' && /^(COUNT|SUM|AVG|MIN|MAX)$/i.test(tok.v) && isOp('(')) {
      next();
      const arg = next().v;
      if (!isOp(')')) throw new Error('seeddb: bad aggregate');
      next();
      select.push({ agg: tok.v.toUpperCase(), arg, key: `${tok.v.toUpperCase()}(${arg})` });
    } else if (tok.t === 'id') {
      select.push({ col: tok.v });
    } else if (tok.t === 'op' && tok.v === '*') {
      select.push({ star: true });
    } else throw new Error('seeddb: bad select item');
  } while (isOp(',') && next());

  expectKw('FROM');
  const from = next().v;
  const joins = [];
  while (isKw('INNER') || isKw('LEFT') || isKw('JOIN')) {
    let kind = 'INNER';
    if (isKw('LEFT')) { kind = 'LEFT'; next(); if (isKw('OUTER')) next(); }
    else if (isKw('INNER')) next();
    expectKw('JOIN');
    const table = next().v;
    expectKw('ON');
    const left = next().v; if (!isOp('=')) throw new Error('seeddb: join needs ='); next(); const right = next().v;
    joins.push({ kind, table, left, right });
  }

  let where = null;
  if (isKw('WHERE')) { next(); where = parseOr(); }

  const groupBy = [];
  if (isKw('GROUP')) { next(); expectKw('BY'); do { groupBy.push(next().v); } while (isOp(',') && next()); }

  const orderBy = [];
  if (isKw('ORDER')) {
    next(); expectKw('BY');
    do {
      const tok = next();
      let key = tok.v;
      if (/^(COUNT|SUM|AVG|MIN|MAX)$/i.test(tok.v) && isOp('(')) { next(); const arg = next().v; next(); key = `${tok.v.toUpperCase()}(${arg})`; }
      let dir = 'ASC';
      if (isKw('ASC') || isKw('DESC')) dir = next().v.toUpperCase();
      orderBy.push({ key, dir });
    } while (isOp(',') && next());
  }

  let limit = { offset: 0, count: 200 };
  if (isKw('LIMIT')) {
    next(); const a = next().v;
    if (isOp(',')) { next(); limit = { offset: a, count: next().v }; } else limit = { offset: 0, count: a };
  }
  if (peek()) throw new Error(`seeddb: unexpected ${JSON.stringify(peek())}`);
  return { select, from, joins, where, groupBy, orderBy, limit };

  function parseOr() { let l = parseAnd(); while (isKw('OR')) { next(); l = { or: [l, parseAnd()] }; } return l; }
  function parseAnd() { let l = parseNot(); while (isKw('AND')) { next(); l = { and: [l, parseNot()] }; } return l; }
  function parseNot() { if (isKw('NOT')) { next(); return { not: parseNot() }; } return parseAtom(); }
  function parseAtom() {
    if (isOp('(')) { next(); const e = parseOr(); if (!isOp(')')) throw new Error('seeddb: missing )'); next(); return e; }
    const left = next();
    if (!left || left.t !== 'id') throw new Error('seeddb: predicate must start with a column');
    if (isKw('IS')) {
      next(); let neg = false; if (isKw('NOT')) { neg = true; next(); } expectKw('NULL');
      return { isnull: left.v, neg };
    }
    const op = next();
    if (!op || op.t !== 'op') throw new Error('seeddb: expected operator');
    const right = next();
    return { cmp: op.v, col: left.v, val: right.t === 'id' ? { ref: right.v } : right.v };
  }
}

/* ------------------------------------------------------------- evaluate */

function get(env, ref) {
  const [q, c] = ref.includes('.') ? ref.split('.') : [null, ref];
  if (q) { const row = env[q]; return row ? row[c] : null; }
  for (const row of Object.values(env)) if (row && c in row) return row[c];
  return null;
}

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}

function compare(a, b, op) {
  a = norm(a); b = norm(b);
  if (a === null || b === null) return false;
  const na = Number(a), nb = Number(b);
  const numeric = a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb);
  const [x, y] = numeric ? [na, nb] : [String(a), String(b)];
  const eq = x === y || String(a).toLowerCase() === String(b).toLowerCase();
  switch (op) {
    case '=': return eq;
    case '<>': case '!=': return !eq;
    case '<': return x < y; case '<=': return x <= y; case '>': return x > y; case '>=': return x >= y;
    default: return false;
  }
}

function evalWhere(expr, env) {
  if (!expr) return true;
  if (expr.and) return expr.and.every((e) => evalWhere(e, env));
  if (expr.or) return expr.or.some((e) => evalWhere(e, env));
  if (expr.not) return !evalWhere(expr.not, env);
  if (expr.isnull) { const v = norm(get(env, expr.isnull)); return expr.neg ? v !== null : v === null; }
  const left = get(env, expr.col);
  const right = expr.val && typeof expr.val === 'object' && 'ref' in expr.val ? get(env, expr.val.ref) : expr.val;
  return compare(left, right, expr.cmp);
}

const SEP = ' || ';

function execute(sql) {
  const q = parse(sql);
  const tablesUsed = [q.from, ...q.joins.map((j) => j.table)];

  let envs = tableRows(q.from).map((r) => ({ [q.from]: r }));
  for (const j of q.joins) {
    const right = tableRows(j.table);
    const [lq, lc] = j.left.split('.'); const [rq, rc] = j.right.split('.');
    // Normalise so joinLeft is the side already in the env and joinRight the
    // table being joined, whichever way the ON was written.
    const joinLeft = lq === j.table ? { q: rq, c: rc } : { q: lq, c: lc };
    const joinRight = lq === j.table ? { q: lq, c: lc } : { q: rq, c: rc };
    const index = new Map();
    for (const r of right) { const k = String(r[joinRight.c]); if (!index.has(k)) index.set(k, []); index.get(k).push(r); }
    const out = [];
    for (const env of envs) {
      const v = env[joinLeft.q]?.[joinLeft.c];
      const matches = v === null || v === undefined ? [] : (index.get(String(v)) ?? []);
      if (matches.length) for (const m of matches) out.push({ ...env, [j.table]: m });
      else if (j.kind === 'LEFT') out.push({ ...env, [j.table]: null });
    }
    envs = out;
  }

  envs = envs.filter((env) => evalWhere(q.where, env));

  const aggs = q.select.filter((s) => s.agg);
  let rows;
  if (aggs.length || q.groupBy.length) {
    const groups = new Map();
    for (const env of envs) {
      const key = q.groupBy.map((g) => String(norm(get(env, g)))).join(SEP);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(env);
    }
    if (!groups.size && !q.groupBy.length) groups.set('', []);
    rows = [...groups.values()].map((members) => {
      const row = {};
      for (const s of q.select) {
        if (s.col) row[s.col.split('.').pop()] = members.length ? norm(get(members[0], s.col)) : null;
        else if (s.agg) {
          const isCount = s.arg === 'ROWID' || s.arg === '*';
          const vals = members.map((e) => (isCount ? 1 : norm(get(e, s.arg)))).filter((v) => v !== null);
          let v;
          if (s.agg === 'COUNT') v = isCount ? members.length : vals.length;
          else {
            const nums = vals.map(Number).filter((n) => !Number.isNaN(n));
            if (s.agg === 'SUM') v = nums.reduce((a, b) => a + b, 0);
            else if (s.agg === 'AVG') v = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
            else if (s.agg === 'MIN') v = nums.length ? Math.min(...nums) : null;
            else v = nums.length ? Math.max(...nums) : null;
          }
          row[s.key] = v;
        }
      }
      return { row, members };
    });
  } else {
    rows = envs.map((env) => {
      const row = {};
      for (const s of q.select) {
        if (s.star) { for (const t of tablesUsed) Object.assign(row, env[t] ?? {}); }
        else row[s.col.split('.').pop()] = norm(get(env, s.col));
      }
      return { row, env };
    });
  }

  const sortValue = (item, key) => {
    if (key in item.row) return item.row[key];
    const short = key.split('.').pop();
    if (short in item.row) return item.row[short];
    if (item.env) return norm(get(item.env, key));
    if (item.members?.length) return norm(get(item.members[0], key));
    return null;
  };
  for (const o of [...q.orderBy].reverse()) {
    rows.sort((a, b) => {
      const av = sortValue(a, o.key), bv = sortValue(b, o.key);
      if (av === bv) return 0; if (av === null) return 1; if (bv === null) return -1;
      const na = Number(av), nb = Number(bv);
      const c = (!Number.isNaN(na) && !Number.isNaN(nb)) ? na - nb : String(av).localeCompare(String(bv));
      return o.dir === 'DESC' ? -c : c;
    });
  }
  rows = rows.slice(q.limit.offset, q.limit.offset + q.limit.count).map((x) => x.row);

  return { rows, tables: tablesUsed };
}

module.exports = { execute, tableRows, build, rowidFor };
