'use strict';

/*
 * AskData - Catalyst Advanced I/O function
 * ========================================
 * An internal tool for Zoho support engineers. They connect to a customer's
 * org, ask a question in plain English, and get an answer plus a sentence they
 * can paste into the ticket - without escalating to a debug engineer.
 *
 * Routes (served under /server/askdata):
 *   GET  /health                  liveness, packs, translator config
 *   GET  /diag                    Connection + model reachability, no secrets
 *   GET  /orgs                    the customer registry, for the demo picker
 *   POST /connect                 { zgid, ticket_id } -> grant_token
 *   POST /ask                     { grant_token, question, history[] }
 *   POST /reveal                  { grant_token, row_id, columns[] }  (audited)
 *   POST /escalate                { grant_token, question }
 *   GET  /audit                   the SupportQueryLog, for a security review
 *   POST /admin/provision-refs    fill the _REF foreign keys after seeding
 *   POST /admin/seed              generate the sample data
 *
 * THE FOUR THINGS THAT ARE NOT NEGOTIABLE, AND WHERE THEY LIVE
 *
 *   read-only        lib/rules.js refuses mutation intent before translating;
 *                    lib/guard.js refuses any non-SELECT verb and logs it as a
 *                    security event. There is no write path to disable.
 *   tenant boundary  lib/grant.js signs {engineer, zgid, ticket}; the ORG_ID
 *                    used for scoping comes from the GRANT, never the body, and
 *                    lib/guard.js injects it unconditionally.
 *   PII masked       lib/mask.js runs server-side, after the query, before
 *                    serialisation. /reveal is per-row and audited.
 *   never guess      lib/people.js returns every candidate for an ambiguous
 *                    name and this file returns mode:"clarify" rather than
 *                    picking one.
 *
 * Every /ask writes a SupportQueryLog row - answered, refused, clarified or
 * errored. That log is the answer to "was AskData used appropriately?", so it
 * is written on every path including the ones that throw.
 */

const catalyst = require('zcatalyst-sdk-node');
const express = require('express');

const packs = require('./lib/packs');
const guard = require('./lib/guard');
const grant = require('./lib/grant');
const store = require('./lib/store');
const replica = require('./lib/replica');
const mask = require('./lib/mask');
const answer = require('./lib/answer');
const rules = require('./lib/rules');
const people = require('./lib/people');
const escalate = require('./lib/escalate');
const nl2zcql = require('./lib/nl2zcql');
const llm = require('./lib/llm');
const { probeConnection } = require('./lib/connection');

const app = express();
app.use(express.json({ type: ['application/json', 'text/plain'], limit: '64kb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-AskData-Engineer');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* ================================================================= health */

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'askdata',
    packs: packs.ALL.map((p) => ({ key: p.key, label: p.label, tables: p.tableNames.length })),
    tables: packs.ALL_TABLES.length,
    translator: {
      model: process.env.QUICKML_MODEL || llm.DEFAULT_MODEL,
      connection: llm.CONNECTION_LINK_NAME,
      timeoutMs: nl2zcql.MODEL_TIMEOUT_MS,
      confidenceFloor: nl2zcql.CONFIDENCE_FLOOR,
    },
    rules: rules.RULES.length,
    grantTtlSeconds: grant.TTL_SECONDS,
  });
});

app.get('/diag', async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const connection = await probeConnection(catalystApp, llm.CONNECTION_LINK_NAME);
  let model = { ok: false, skipped: 'connection unavailable' };

  if (connection.ok) {
    const started = Date.now();
    try {
      const loaded = packs.forOrg({ SUBSCRIBED_PRODUCTS: 'crm' });
      const out = await nl2zcql.translate(catalystApp, { question: 'how many leads do we have', loaded });
      model = { ok: true, ms: Date.now() - started, intent: out.intent, zcql: out.zcql };
    } catch (err) {
      model = { ok: false, ms: Date.now() - started, error: err.message };
    }
  }
  res.json({ connection, model, engineerIdentity: process.env.ASKDATA_ENV ?? 'Development' });
});

app.get('/orgs', async (req, res) => {
  try {
    res.json({ orgs: await store.listOrgs(catalyst.initialize(req)) });
  } catch (err) {
    console.error('GET /orgs failed:', err);
    res.status(500).json({ error: 'Could not list orgs.' });
  }
});

/* ================================================================ connect */

/**
 * Connect to a customer.
 *
 * The engineer is identified from their Catalyst session; the entitlement check
 * asks whether they have a live reason to be in this org *right now*. No open
 * ticket and no elevated grant means refused - and the refusal is logged as a
 * security event, because an engineer probing orgs they have no business in is
 * exactly what a review needs to see.
 */
app.post('/connect', async (req, res) => {
  const started = Date.now();
  const catalystApp = catalyst.initialize(req);
  const zgid = String(req.body?.zgid ?? '').trim();
  const ticketId = String(req.body?.ticket_id ?? '').trim();

  try {
    if (!/^[0-9]{4,32}$/.test(zgid)) {
      return res.status(400).json({ error: 'A ZGID is digits only - copy it from the ticket.' });
    }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(ticketId)) {
      return res.status(400).json({ error: 'Enter the ticket you are working on.' });
    }

    const engineer = await grant.identifyEngineer(catalystApp, req);
    const org = await store.findOrgByZgid(catalystApp, zgid);

    if (!org) {
      return res.status(404).json({ error: `No customer found with ZGID ${zgid}.` });
    }

    const entitlement = await store.entitlementFor(catalystApp, {
      engineerEmail: engineer.email, zgid, ticketId,
    });

    if (!entitlement) {
      // Logged against the org so a reviewer can see who tried to get in.
      await store.logQuery(catalystApp, {
        orgId: org.ORG_ID, zgid, ticketId,
        engineerId: engineer.id, engineerEmail: engineer.email,
        question: '[connect]', zcql: '', outcome: 'refused',
        verdict: `SECURITY: no live entitlement for ${engineer.email} on zgid ${zgid} ticket ${ticketId}`,
        rowCount: 0, latencyMs: Date.now() - started, security: true,
      });
      return res.status(403).json({
        error:
          `You do not have a live reason to open ${org.ORG_NAME}. ` +
          'Connect from an open ticket for this customer, or request elevated access.',
        code: 'not_entitled',
      });
    }

    const issued = grant.issue({ engineer, org, ticketId });
    const loaded = packs.forOrg(org);

    res.json({
      grant_token: issued.token,
      org_name: org.ORG_NAME,
      zgid: org.ZGID,
      dc: org.DC,
      edition: org.EDITION,
      products: loaded.productKeys,
      pack_labels: loaded.packs.filter((p) => !p.always).map((p) => p.label),
      queryable_tables: loaded.tableNames.length,
      ticket_id: ticketId,
      entitled_via: entitlement.via,
      engineer: { email: engineer.email, identified_by: engineer.source },
      expires_at: issued.expires_at,
      expires_in_seconds: grant.TTL_SECONDS,
      suggestions: rules.suggestionsFor(loaded),
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    if (err.name === 'GrantError') {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('connect failed:', err);
    res.status(500).json({ error: 'Could not connect to that customer.' });
  }
});

/* ==================================================================== ask */

/** Everything /ask needs, resolved from the grant. Throws GrantError. */
async function context(catalystApp, req) {
  const claims = grant.verify(req.body?.grant_token);
  const org = await store.findOrgByZgid(catalystApp, claims.zgid);
  if (!org || org.ORG_ID !== claims.orgId) {
    throw new grant.GrantError('That customer is no longer available. Connect again.', { code: 'org_gone' });
  }
  return { claims, org, loaded: packs.forOrg(org) };
}

app.post('/ask', async (req, res) => {
  const started = Date.now();
  const catalystApp = catalyst.initialize(req);
  const question = String(req.body?.question ?? '').trim();
  const history = Array.isArray(req.body?.history) ? req.body.history : [];

  let ctx;
  try {
    ctx = await context(catalystApp, req);
  } catch (err) {
    // No grant means no org, so there is nothing to scope a log row to. This is
    // the one path that cannot be audited against a customer, by construction.
    console.warn(`/ask rejected: ${err.message}`);
    return res.status(err.status ?? 403).json({
      mode: 'refused',
      reason: err.message,
      code: err.code ?? 'no_grant',
      escalation_draft: null,
    });
  }

  const { claims, org, loaded } = ctx;
  const base = {
    orgId: org.ORG_ID, zgid: claims.zgid, ticketId: claims.ticketId,
    engineerId: claims.engineerId, engineerEmail: claims.engineerEmail, question,
  };

  const finish = async (payload, log) => {
    const latencyMs = Date.now() - started;
    await store.logQuery(catalystApp, { ...base, ...log, latencyMs });
    return res.status(payload.status ?? 200).json({
      ...payload.body,
      grant: { expires_at: new Date(claims.expiresAt * 1000).toISOString(), seconds_left: claims.secondsLeft },
      latency_ms: latencyMs,
    });
  };

  if (!question) {
    return finish(
      { status: 400, body: { mode: 'clarify', question: 'What would you like me to check?', suggestions: rules.suggestionsFor(loaded) } },
      { outcome: 'clarify', verdict: 'empty question', zcql: '', rowCount: 0 }
    );
  }

  try {
    /* -- 1. does this ask for a CHANGE? --------------------------------- */
    if (rules.mutationIntent(question)) {
      const draft = escalate.build({
        question, reason: 'asks for a change; AskData is read-only',
        orgId: org.ORG_ID, zgid: claims.zgid, ticketId: claims.ticketId,
        engineerEmail: claims.engineerEmail, loaded, orgName: org.ORG_NAME,
      });
      return finish({
        body: {
          mode: 'refused',
          reason:
            'AskData can only read data, never change it. A change has to go through a debug ' +
            'engineer so it gets review and a rollback path. I have drafted the escalation for you.',
          escalation_draft: draft,
        },
      }, { outcome: 'refused', verdict: 'SECURITY: mutation intent in question', zcql: '', rowCount: 0, security: true });
    }

    /* -- 2. is it about the customer's data at all? --------------------- */
    if (rules.offTopic(question)) {
      return finish({
        body: {
          mode: 'clarify',
          question:
            "I couldn't tell what to look up. Name the module you mean - " +
            `${loaded.tables.filter((t) => t.pack !== 'platform').slice(0, 4).map((t) => t.label).join(', ')} - ` +
            'or a record id.',
          suggestions: rules.suggestionsFor(loaded),
        },
      }, { outcome: 'clarify', verdict: 'off-topic question', zcql: '', rowCount: 0 });
    }

    /* -- 3. who or what does it name? ---------------------------------- */
    let person = null;
    try {
      const roster = await people.roster(catalystApp, org.ORG_ID);
      const found = people.findPeople(question, roster);

      if (found?.ambiguous) {
        // RULE 4. Never pick one. A permissions or exfiltration answer about
        // the wrong person is a false accusation with a query log behind it.
        const candidates = people.clarifyCandidates(found, question);
        return finish({
          body: {
            mode: 'clarify',
            question:
              `There ${found.matches.length === 2 ? 'are two people' : `are ${found.matches.length} people`} ` +
              `matching "${found.term}" in ${org.ORG_NAME}. Which one do you mean?`,
            candidates,
            suggestions: candidates.map((c) => c.suggestion),
          },
        }, {
          outcome: 'clarify', zcql: '', rowCount: 0,
          verdict: `ambiguous person "${found.term}" -> ${found.matches.map((m) => m.USER_ID).join(', ')}`,
        });
      }
      if (found) person = found.matches[0];
    } catch (err) {
      console.warn(`name resolution skipped: ${err.message}`);
    }

    let account = null;
    if (/\b(?:at|for|of|in)\s+[A-Z]/.test(question) || /contact|account|company/i.test(question)) {
      try {
        const accounts = replica.flattenRows(await catalystApp.zcql().executeZCQLQuery(
          `SELECT ACCOUNT_ID, ACCOUNT_NAME FROM CRM_Accounts WHERE ORG_ID = '${store.q(org.ORG_ID)}' LIMIT 0, 300`
        ));
        const hit = people.resolveLabel(question, accounts, 'ACCOUNT_NAME');
        if (hit?.ambiguous) {
          return finish({
            body: {
              mode: 'clarify',
              question: `Several accounts match that name in ${org.ORG_NAME}. Which one?`,
              candidates: hit.matches.slice(0, 8).map((a) => ({
                account_id: a.ACCOUNT_ID, account_name: a.ACCOUNT_NAME,
                suggestion: people.replaceTerm(question, a.ACCOUNT_NAME, a.ACCOUNT_NAME),
              })),
            },
          }, { outcome: 'clarify', zcql: '', rowCount: 0, verdict: 'ambiguous account label' });
        }
        if (hit) account = hit.matches[0];
      } catch { /* CRM not subscribed, or no accounts - not fatal */ }
    }

    const resolved = { person, account };

    /* -- 4. translate: model first, rules behind it -------------------- */
    let proposed = null;
    let engine = null;
    let modelNote = null;

    try {
      const out = await nl2zcql.translate(catalystApp, { question, loaded, history, person });
      if (out.intent === 'refuse') {
        modelNote = `model refused: ${out.explanation || 'no reason given'}`;
      } else if (out.intent === 'clarify' || out.confidence < nl2zcql.CONFIDENCE_FLOOR) {
        modelNote = `model ${out.intent === 'clarify' ? 'asked to clarify' : `was unsure (${out.confidence})`}`;
        if (out.intent === 'clarify' && out.clarify_question) {
          return finish({
            body: { mode: 'clarify', question: out.clarify_question, suggestions: rules.suggestionsFor(loaded) },
          }, { outcome: 'clarify', zcql: out.zcql, rowCount: 0, verdict: modelNote });
        }
      } else if (out.zcql) {
        proposed = out.zcql;
        engine = 'model';
      }
    } catch (err) {
      modelNote = `model unavailable: ${err.message}`;
      console.warn(modelNote);
    }

    if (!proposed) {
      const ruled = rules.translate(question, resolved);
      if (ruled) {
        proposed = ruled.zcql;
        engine = `rules:${ruled.ruleId}`;
      }
    }

    if (!proposed) {
      const draft = escalate.build({
        question, reason: modelNote ?? 'no pattern matched this question',
        orgId: org.ORG_ID, zgid: claims.zgid, ticketId: claims.ticketId,
        engineerEmail: claims.engineerEmail, resolved, loaded, orgName: org.ORG_NAME,
      });
      return finish({
        body: {
          mode: 'clarify',
          question:
            "I couldn't work out how to look that up. Try naming the module - " +
            `${loaded.tables.filter((t) => t.pack !== 'platform').slice(0, 4).map((t) => t.label).join(', ')} - ` +
            'or give me a record id.',
          suggestions: rules.suggestionsFor(loaded),
          escalation_draft: draft,
        },
      }, { outcome: 'clarify', zcql: '', rowCount: 0, verdict: modelNote ?? 'no rule matched' });
    }

    /* -- 5. the guard decides ------------------------------------------ */
    let compiled;
    try {
      compiled = guard.compile(proposed, org.ORG_ID, loaded);
    } catch (err) {
      if (err.name !== 'Refused') throw err;
      const draft = escalate.build({
        question, reason: err.reason,
        orgId: org.ORG_ID, zgid: claims.zgid, ticketId: claims.ticketId,
        engineerEmail: claims.engineerEmail, resolved, loaded, orgName: org.ORG_NAME,
      });
      return finish({
        body: {
          mode: 'refused', reason: err.reason,
          suggestions: err.suggestions?.length ? err.suggestions : rules.suggestionsFor(loaded).slice(0, 5),
          escalation_draft: draft,
        },
      }, {
        outcome: 'refused', zcql: proposed, rowCount: 0,
        verdict: `${err.security ? 'SECURITY: ' : ''}${err.verdict} [via ${engine}]`,
        security: err.security,
      });
    }

    /* -- 6. read, mask, describe --------------------------------------- */
    const result = await replica.read(catalystApp, org, compiled.zcql);
    const masked = mask.maskRows(result.rows, compiled.tables, loaded);
    const described = answer.build({
      question, rows: masked.rows, columns: result.columns,
      tables: compiled.tables, loaded, replica: result,
    });

    return finish({
      body: {
        mode: 'answer',
        zcql: compiled.zcql,
        engine,
        rows: masked.rows,
        columns: result.columns,
        row_count: masked.rows.length,
        summary: described.summary,
        ticket_comment: described.ticket_comment,
        highlights: described.highlights,
        masked: masked.masked,
        as_of: result.as_of,
        replica_lag_seconds: result.lag_seconds,
        replica_source: result.source,
        dc: result.dc,
        tables: compiled.tables,
        org_scope: compiled.injected,
        person: person ? { user_id: person.USER_ID, full_name: mask.maskValue(person.FULL_NAME, 'name') } : null,
        model_note: modelNote,
        shaper: described.shaper,
      },
    }, {
      outcome: 'answered', zcql: compiled.zcql, rowCount: masked.rows.length,
      verdict: `${compiled.verdict} [via ${engine}]`,
      piiRevealed: '',
    });
  } catch (err) {
    console.error('/ask failed:', err);
    return finish({
      status: 500,
      body: {
        mode: 'refused',
        reason: 'Something went wrong looking that up. Nothing was changed.',
        escalation_draft: escalate.build({
          question, reason: `internal error: ${err.message}`,
          orgId: org.ORG_ID, zgid: claims.zgid, ticketId: claims.ticketId,
          engineerEmail: claims.engineerEmail, loaded, orgName: org.ORG_NAME,
        }),
      },
    }, { outcome: 'error', zcql: '', rowCount: 0, verdict: `error: ${err.message}`.slice(0, 200) });
  }
});

/* ================================================================= reveal */

/**
 * Un-mask one row.
 *
 * Per row, never "reveal all": the audit trail is the deterrent, and a bulk
 * reveal makes it meaningless. The row is re-read by ROWID under the grant's
 * org, so a reveal cannot reach a row the engineer was never shown.
 */
app.post('/reveal', async (req, res) => {
  const started = Date.now();
  const catalystApp = catalyst.initialize(req);

  let ctx;
  try {
    ctx = await context(catalystApp, req);
  } catch (err) {
    return res.status(err.status ?? 403).json({ error: err.message, code: err.code });
  }
  const { claims, org, loaded } = ctx;

  const table = String(req.body?.table ?? '').trim();
  const rowId = String(req.body?.row_id ?? '').trim();
  const columns = Array.isArray(req.body?.columns) ? req.body.columns.map(String) : [];

  const canonical = loaded.resolveTableName(table);
  if (!canonical) return res.status(400).json({ error: 'I do not have that kind of record.' });
  if (!/^\d{1,25}$/.test(rowId)) return res.status(400).json({ error: 'Reveal needs one specific row.' });

  const piiCols = loaded.pii[canonical] ?? {};
  const asked = columns.filter((c) => piiCols[c.toUpperCase()]).map((c) => c.toUpperCase());
  if (!asked.length) {
    return res.status(400).json({ error: 'Nothing masked to reveal on that row.' });
  }

  try {
    const sql =
      `SELECT ${asked.map((c) => `${canonical}.${c}`).join(', ')} FROM ${canonical} ` +
      `WHERE ${canonical}.ROWID = ${rowId} AND ${canonical}.ORG_ID = '${store.q(org.ORG_ID)}' LIMIT 0, 1`;
    const rows = replica.flattenRows(await catalystApp.zcql().executeZCQLQuery(sql));

    if (!rows.length) {
      return res.status(404).json({ error: 'That row is not in this customer\'s data.' });
    }

    await store.logQuery(catalystApp, {
      orgId: org.ORG_ID, zgid: claims.zgid, ticketId: claims.ticketId,
      engineerId: claims.engineerId, engineerEmail: claims.engineerEmail,
      question: `[pii_reveal] ${canonical}#${rowId}`,
      zcql: sql, outcome: 'answered',
      verdict: `pii_reveal ${canonical}.${asked.join('+')} row ${rowId}`,
      rowCount: 1, latencyMs: Date.now() - started,
      piiRevealed: `${canonical}:${asked.join('+')}`,
      security: true,
    });

    res.json({
      values: rows[0],
      table: canonical,
      row_id: rowId,
      columns: asked,
      audited: true,
      audit_note: `Logged against ticket ${claims.ticketId} as ${claims.engineerEmail}.`,
    });
  } catch (err) {
    console.error('/reveal failed:', err);
    res.status(500).json({ error: 'Could not reveal that row.' });
  }
});

/* =============================================================== escalate */

app.post('/escalate', async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  let ctx;
  try {
    ctx = await context(catalystApp, req);
  } catch (err) {
    return res.status(err.status ?? 403).json({ error: err.message, code: err.code });
  }
  const { claims, org, loaded } = ctx;
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'Nothing to escalate.' });

  let person = null;
  try {
    const found = people.findPeople(question, await people.roster(catalystApp, org.ORG_ID));
    if (found && !found.ambiguous) person = found.matches[0];
  } catch { /* best effort */ }

  const draft = escalate.build({
    question,
    reason: String(req.body?.reason ?? 'the support engineer asked for a debug engineer'),
    orgId: org.ORG_ID, zgid: claims.zgid, ticketId: claims.ticketId,
    engineerEmail: claims.engineerEmail, resolved: { person }, loaded, orgName: org.ORG_NAME,
  });

  await store.logQuery(catalystApp, {
    orgId: org.ORG_ID, zgid: claims.zgid, ticketId: claims.ticketId,
    engineerId: claims.engineerId, engineerEmail: claims.engineerEmail,
    question: `[escalate] ${question}`, zcql: draft.zcql, outcome: 'refused',
    verdict: `escalated to debug engineer (${draft.basis})`, rowCount: 0, latencyMs: 0,
  });

  res.json({ ...draft, ticket_id: claims.ticketId, org_name: org.ORG_NAME });
});

/* ================================================================== audit */

app.get('/audit', async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const orgId = String(req.query.org_id ?? '').trim();
  try {
    const rows = orgId
      ? await store.recentLog(catalystApp, orgId, Number(req.query.limit) || 100)
      : await store.fullLog(catalystApp, Number(req.query.limit) || 300);
    const byOutcome = rows.reduce((acc, r) => {
      acc[r.OUTCOME] = (acc[r.OUTCOME] ?? 0) + 1;
      return acc;
    }, {});
    res.json({ count: rows.length, by_outcome: byOutcome, log: rows });
  } catch (err) {
    console.error('/audit failed:', err);
    res.status(500).json({ error: 'Could not read the audit log.' });
  }
});

/* ================================================================== admin */

function adminOk(req) {
  const expected = process.env.ASKDATA_ADMIN_TOKEN;
  return Boolean(expected) && req.get('x-askdata-admin') === expected;
}

app.post('/admin/seed', async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'Admin token required.' });
  const started = Date.now();
  try {
    const out = await require('./lib/seed').seed(catalyst.initialize(req), {
      only: req.body?.only ?? null,
      wipe: req.body?.wipe !== false,
    });
    res.json({ ok: true, ms: Date.now() - started, ...out });
  } catch (err) {
    console.error('seed failed:', err);
    res.status(500).json({ ok: false, error: err.message, stack: String(err.stack).split('\n').slice(0, 4) });
  }
});

app.post('/admin/provision-refs', async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'Admin token required.' });
  const started = Date.now();
  try {
    const out = await require('./lib/seed').backfillRefs(catalyst.initialize(req));
    res.json({ ok: true, ms: Date.now() - started, ...out });
  } catch (err) {
    console.error('backfill failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: `No route ${req.method} ${req.path}` }));

module.exports = app;
