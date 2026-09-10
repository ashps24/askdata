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
const spell = require('./lib/spell');
const spool = require('./lib/spool');
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
    // Outside Production an engineer identity may come from a header, so the
    // hosted client can be used without a Catalyst sign-in. Advertised rather
    // than assumed, so the client shows it as the stand-in that it is.
    devIdentity: {
      allowed: process.env.ASKDATA_ENV !== 'Production',
      engineer: process.env.ASKDATA_DEMO_ENGINEER || null,
    },
    requireAudit: store.requireAudit(),
  });
});

/**
 * Is the model translator wired up, and if not, what exactly is missing?
 *
 * There are two prerequisites and they fail in ways that look alike, so this
 * separates them and names the next step. Reporting "model unavailable" sent
 * someone looking at the Connection when the real problem was that GLM serving
 * is provisioned per project and this project is not one of them.
 *
 * Reports shape only. No token material is ever printed - see probeConnection.
 */
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

  const setup = { ready: connection.ok && model.ok, steps: [] };

  setup.steps.push({
    step: 'Connection',
    name: llm.CONNECTION_LINK_NAME,
    done: connection.ok,
    todo: connection.ok ? null
      : `Catalyst console -> project AskData -> Connections -> create one named exactly ` +
        `"${llm.CONNECTION_LINK_NAME}" with scope QuickML.deployment.READ, then authorize it.`,
    detail: connection.ok ? null : connection.error,
  });

  setup.steps.push({
    step: 'GLM serving project',
    project: process.env.ASKDATA_QUICKML_PROJECT_ID || process.env.CATALYST_PROJECT_ID || null,
    configured: Boolean(process.env.ASKDATA_QUICKML_PROJECT_ID),
    done: model.ok,
    todo: model.ok ? null
      : 'GLM serving is provisioned per project. If the Connection resolves but this ' +
        'still fails, point ASKDATA_QUICKML_PROJECT_ID at a project where QuickML is ' +
        'enabled and redeploy.',
    detail: model.ok ? null : (model.error ?? model.skipped),
  });

  setup.next = setup.ready
    ? 'Nothing - the model translator is live. Answers will report engine "model".'
    : setup.steps.find((s) => !s.done)?.todo ?? null;

  // Answers keep working either way; this only decides which engine writes them.
  setup.fallback = `${rules.RULES.length} deterministic rules, labelled "rules" on every answer.`;

  res.json({ setup, connection, model, engineerIdentity: process.env.ASKDATA_ENV ?? 'Development' });
});

app.get('/orgs', async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  try {
    const orgs = await store.listOrgs(catalystApp);

    // Attach the tickets THIS engineer holds for each customer, so the connect
    // panel can offer them instead of leaving a stale one in the box. Their own
    // entitlements only - see store.myEntitlements.
    let entitlements = new Map();
    try {
      const engineer = await grant.identifyEngineer(catalystApp, req);
      entitlements = await store.myEntitlements(catalystApp, engineer.email);
    } catch { /* not signed in: the picker still works, just without tickets */ }

    res.json({
      orgs: orgs.map((o) => ({
        ...o,
        open_tickets: entitlements.get(o.ZGID)?.open_tickets ?? [],
        elevated: entitlements.get(o.ZGID)?.elevated ?? false,
      })),
    });
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
const SERVICES = ['crm', 'campaigns', 'desk'];

app.post('/connect', async (req, res) => {
  const started = Date.now();
  const catalystApp = catalyst.initialize(req);
  const service = String(req.body?.service ?? '').trim().toLowerCase();
  const serviceOrgId = String(req.body?.service_org_id ?? '').trim();
  const zgid = String(req.body?.zgid ?? '').trim();
  const ticketId = String(req.body?.ticket_id ?? '').trim();

  // Two ways to name a customer. The service form is what an engineer has in
  // front of them - they picked a service and pasted that service's org id. The
  // bare ZGID stays supported because tickets, entitlements and every audit row
  // already written are keyed to it.
  const byService = Boolean(service) && service !== 'all';
  const orgIdTyped = byService ? serviceOrgId : zgid;

  try {
    if (byService && !SERVICES.includes(service)) {
      return res.status(400).json({
        error: `Unknown service "${service}". Choose one of: ${SERVICES.join(', ')}.`,
      });
    }
    if (!/^[0-9]{4,32}$/.test(orgIdTyped)) {
      return res.status(400).json({
        error: byService
          ? `A ${service} org id is digits only - copy it from the ticket.`
          : 'A ZGID is digits only - copy it from the ticket.',
      });
    }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(ticketId)) {
      return res.status(400).json({ error: 'Enter the ticket you are working on.' });
    }

    const engineer = await grant.identifyEngineer(catalystApp, req);
    const org = byService
      ? await store.findOrgByServiceId(catalystApp, service, serviceOrgId)
      : await store.findOrgByZgid(catalystApp, zgid);

    if (!org) {
      return res.status(404).json({
        error: byService
          ? `No customer has ${serviceOrgId} as their ${service} org id. Check the id, ` +
            'and check the ticket is really about that service.'
          : `No customer found with ZGID ${zgid}.`,
        code: 'org_not_found',
      });
    }

    // Entitlements are held against the company's ZGID, not against whichever
    // service id happened to be typed - one open ticket entitles the engineer to
    // the customer, and the service only narrows what they can read.
    const entitlement = await store.entitlementFor(catalystApp, {
      engineerEmail: engineer.email, zgid: org.ZGID, ticketId,
    });

    if (!entitlement) {
      // Logged against the org so a reviewer can see who tried to get in.
      await store.logQuery(catalystApp, {
        orgId: org.ORG_ID, zgid: org.ZGID, ticketId,
        engineerId: engineer.id, engineerEmail: engineer.email,
        question: '[connect]', zcql: '', outcome: 'refused',
        verdict: `SECURITY: no live entitlement for ${engineer.email} on zgid ${org.ZGID} ticket ${ticketId}`,
        rowCount: 0, latencyMs: Date.now() - started, security: true,
      });
      // Say WHY, when we can do it without telling them anything new. The
      // usual cause is the previous customer's ticket left in the box, and
      // "no live reason" sends someone hunting for a permissions problem that
      // is really a typo.
      let hint = '';
      try {
        const owner = await store.ticketBelongsTo(catalystApp, engineer.email, ticketId);
        if (owner && owner !== org.ZGID) {
          const ownerOrg = await store.findOrgByZgid(catalystApp, owner);
          hint = ` ${ticketId} is one of your open tickets, but it is for ` +
            `${ownerOrg?.ORG_NAME ?? `ZGID ${owner}`}, not ${org.ORG_NAME}.`;
        } else {
          const mine = await store.myEntitlements(catalystApp, engineer.email);
          const tickets = mine.get(org.ZGID)?.open_tickets ?? [];
          hint = tickets.length
            ? ` Your open ${tickets.length === 1 ? 'ticket' : 'tickets'} for ` +
              `${org.ORG_NAME}: ${tickets.join(', ')}.`
            : ` You hold no open ticket for ${org.ORG_NAME}.`;
        }
      } catch { /* the refusal stands with or without the hint */ }

      return res.status(403).json({
        error:
          `${ticketId} is not a live reason to open ${org.ORG_NAME}.${hint}`,
        code: 'not_entitled',
      });
    }

    const loaded = byService ? packs.forOrgService(org, service) : packs.forOrg(org);
    if (!loaded) {
      return res.status(400).json({
        error:
          `${org.ORG_NAME} is not subscribed to ${service}. Their services are: ` +
          `${org.SUBSCRIBED_PRODUCTS}.`,
        code: 'service_not_subscribed',
      });
    }

    const issued = grant.issue({
      engineer, org, ticketId,
      service: byService ? service : 'all',
      serviceOrgId: byService ? serviceOrgId : org.ZGID,
    });

    res.json({
      grant_token: issued.token,
      org_name: org.ORG_NAME,
      zgid: org.ZGID,
      service: byService ? service : 'all',
      service_org_id: byService ? serviceOrgId : org.ZGID,
      // What else this customer has, so the client can offer the switch without
      // a second round trip.
      services_available: serviceOrgIdsFor(org),
      dc: org.DC,
      edition: org.EDITION,
      products: loaded.productKeys,
      pack_labels: loaded.packs.filter((p) => !p.always).map((p) => p.label),
      queryable_tables: loaded.tableNames.length,
      explorable_tables: loaded.tables.filter((t) => !t.internal).map((t) => ({
        name: t.name, label: t.label, columns: t.columnNames.length,
      })),
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
  // Scope comes from the signed grant, never the request. A session opened on
  // Desk cannot widen itself to CRM by asking a CRM question.
  const loaded = claims.service && claims.service !== 'all'
    ? packs.forOrgService(org, claims.service)
    : packs.forOrg(org);

  if (!loaded) {
    throw new grant.GrantError(
      `${org.ORG_NAME} is no longer subscribed to ${claims.service}. Connect again.`,
      { code: 'service_gone' }
    );
  }
  return { claims, org, loaded };
}

/** The org ids this customer's tickets can quote, by service. */
function serviceOrgIdsFor(org) {
  return SERVICES
    .map((key) => ({ service: key, org_id: org[store.SERVICE_COLUMN[key]] ?? null }))
    .filter((s) => s.org_id);
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

  // Correct the typing before anything reads the question. Both engines
  // benefit: the rules match on substrings that a misspelling destroys, and
  // the model gets a cleaner prompt. The ORIGINAL is what gets audited - the
  // log has to show what the engineer actually typed - and the corrections
  // ride along on the answer so they can see what was read.
  const spelled = spell.correct(question, loaded);
  const asked = spelled.text;

  const base = {
    orgId: org.ORG_ID, zgid: claims.zgid, ticketId: claims.ticketId,
    engineerId: claims.engineerId, engineerEmail: claims.engineerEmail, question,
  };

  const finish = async (payload, log) => {
    const latencyMs = Date.now() - started;
    const audit = await store.logQuery(catalystApp, {
      ...base, ...log, latencyMs,
      verdict: spelled.changed
        ? `${log.verdict ?? ''} [read as: ${asked}]`.trim()
        : log.verdict,
    });

    // Fail closed only when there is genuinely NO record. A spooled entry is a
    // record - durable, enumerable, and drained into the table by bulk write -
    // so it satisfies the guarantee even though the table has not caught up.
    if (!audit.ok && store.requireAudit()) {
      return res.status(503).json({
        mode: 'refused',
        reason:
          'I could not write the audit record for this query, so I have not run it. ' +
          'Every AskData query has to be auditable. Please retry, and raise this with ' +
          'the platform team if it persists.',
        code: 'audit_unavailable',
        audit: { written: false, error: audit.error },
        latency_ms: latencyMs,
      });
    }

    return res.status(payload.status ?? 200).json({
      ...payload.body,
      ...(spelled.changed
        ? { interpreted_as: asked, corrections: spelled.corrections }
        : {}),
      ...(audit.ok && !audit.spooled ? {} : {
        audit: audit.ok
          ? {
            written: true,
            pending: true,
            note: 'Recorded, and waiting to be written into the audit table.',
            reason: audit.reason,
          }
          : {
            written: false,
            warning: 'This query was NOT recorded in the audit log. Do not rely on it for a review.',
            error: audit.error,
          },
      }),
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
    if (rules.mutationIntent(asked)) {
      const draft = escalate.build({
        question: asked, reason: 'asks for a change; AskData is read-only',
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
    if (rules.offTopic(asked, loaded)) {
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
      const found = people.findPeople(asked, roster);

      if (found?.ambiguous) {
        // RULE 4. Never pick one. A permissions or exfiltration answer about
        // the wrong person is a false accusation with a query log behind it.
        const candidates = people.clarifyCandidates(found, asked);
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

    /* -- 3b. the SERVICE boundary on permission questions ---------------- */
    //
    // Permissions live in shared platform tables, so the guard's table
    // allow-list cannot catch a question about another service's permissions.
    // Two cases, both before any query is written:
    //
    //   the question names a module from ANOTHER service ("who can delete
    //   leads" in a Desk session) - refuse, and say which session to open;
    //
    //   it names an action but no module ("who can delete records") - ask
    //   which, offering only THIS service's modules. Answering across every
    //   module of every product is how a Desk session came back with CRM rows.
    if (rules.accessQuestion(asked.toLowerCase(), { permission: rules.permissionTarget(asked) })) {
      const target = rules.permissionTarget(asked);
      const service = loaded.serviceKey && loaded.serviceKey !== 'all' ? loaded.serviceKey : null;
      const label = { crm: 'Zoho CRM', campaigns: 'Zoho Campaigns', desk: 'Zoho Desk' };

      if (target && service && target.product !== service) {
        const owns = (loaded.orgProducts ?? []).includes(target.product);
        return finish({
          body: {
            mode: 'refused',
            reason: owns
              ? `You are connected to this customer's ${label[service]} data, and ${target.module.toLowerCase()} ` +
                `belong to ${label[target.product]}. Reconnect with their ${target.product} org id to ask about ` +
                `${target.module.toLowerCase()} permissions.`
              : `This customer isn't subscribed to ${label[target.product]}, so there are no ` +
                `${target.module.toLowerCase()} permissions to check. Their products are: ` +
                `${(loaded.orgProducts ?? []).join(', ')}.`,
            suggestions: rules.modulesFor(service, loaded.orgProducts)
              .map((m) => asked.replace(new RegExp(`\\b${target.module.toLowerCase()}\\b|\\b${target.module.toLowerCase().replace(/s$/, '')}\\b`, 'i'), m.plural)),
            escalation_draft: null,
          },
        }, {
          outcome: 'refused', zcql: '', rowCount: 0,
          verdict: `permission target ${target.key} is outside the session service (${service})`,
        });
      }

      const action = rules.permissionAction(asked);
      if (action && !target) {
        const modules = rules.modulesFor(service, loaded.orgProducts);
        const verb = /\b(delete|remove|create|add|edit|update|export|view|share|approve)\b/i.exec(asked)?.[1] ?? action;
        return finish({
          body: {
            mode: 'clarify',
            question:
              `${verb.charAt(0).toUpperCase() + verb.slice(1).toLowerCase()} what? ` +
              `${service ? `In ${label[service]} that could be ` : 'That could be '}` +
              `${modules.map((m) => m.plural).join(', ')}.`,
            suggestions: modules.map((m) => asked.replace(/\b(records?|data|things?|items?|entries|stuff|anything)\b/i, m.plural))
              .map((q, i) => (q === asked ? `${asked} - ${modules[i].plural}` : q)),
          },
        }, {
          outcome: 'clarify', zcql: '', rowCount: 0,
          verdict: `permission action "${action}" named no module; offered ${modules.map((m) => m.module).join(', ')}`,
        });
      }
    }

    // A question ABOUT a person that never names one. Asking is the only honest
    // move: guessing would breach rule 4, and refusing sends the engineer back
    // to the debug queue over a missing word.
    if (!person && rules.vaguePersonReference(asked)) {
      const target = rules.permissionTarget(asked);
      return finish({
        body: {
          mode: 'clarify',
          question:
            `Which user? Give me their user id, full name or email address and I will check ` +
            `${target ? `whether they have ${target.key}` : 'it'} on ${org.ORG_NAME}.`,
          candidates: [],
          // Both are runnable as-is; the engineer swaps the id for the one on
          // the ticket. A placeholder like "<user email>" would be a suggestion
          // that fails when clicked.
          suggestions: [
            people.replaceVaguePerson(asked, 'U-2004'),
            target ? `does U-2004 have ${target.key}` : null,
          ].filter(Boolean),
        },
      }, {
        outcome: 'clarify', zcql: '', rowCount: 0,
        verdict: 'person referred to but not named',
      });
    }

    let account = null;
    let accounts = [];
    if (/\b(?:at|for|of|in)\s+[A-Z]/.test(asked) || /contact|account|company/i.test(asked)) {
      try {
        accounts = replica.flattenRows(await catalystApp.zcql().executeZCQLQuery(
          `SELECT ACCOUNT_ID, ACCOUNT_NAME FROM CRM_Accounts WHERE ORG_ID = '${store.q(org.ORG_ID)}' LIMIT 0, 300`
        ));
        const hit = people.resolveLabel(asked, accounts, 'ACCOUNT_NAME');
        if (hit?.ambiguous) {
          return finish({
            body: {
              mode: 'clarify',
              question: `Several accounts match that name in ${org.ORG_NAME}. Which one?`,
              candidates: hit.matches.slice(0, 8).map((a) => ({
                account_id: a.ACCOUNT_ID, account_name: a.ACCOUNT_NAME,
                suggestion: people.replaceTerm(asked, a.ACCOUNT_NAME, a.ACCOUNT_NAME),
              })),
            },
          }, { outcome: 'clarify', zcql: '', rowCount: 0, verdict: 'ambiguous account label' });
        }
        if (hit) account = hit.matches[0];
      } catch { /* CRM not subscribed, or no accounts - not fatal */ }
    }

    // A name the question filters on that matched nothing. Answering anyway
    // means answering a DIFFERENT question - the org-wide one - and saying so
    // with a confident number. See rules.namedEntity.
    if (!account && !person) {
      const named = rules.namedEntity(asked, loaded);
      if (named) {
        const near = people.nearestLabels(named, accounts, 'ACCOUNT_NAME', 3);
        return finish({
          body: {
            mode: 'clarify',
            question:
              `I could not find "${named}" in ${org.ORG_NAME}` +
              `${near.length ? '. Did you mean one of these?' : ', so I have not answered - the count for the whole account would be a different question.'}`,
            candidates: near.map((a) => ({ account_id: a.ACCOUNT_ID, account_name: a.ACCOUNT_NAME })),
            suggestions: near.map((a) => people.replaceTerm(asked, named, a.ACCOUNT_NAME)),
          },
        }, {
          outcome: 'clarify', zcql: '', rowCount: 0,
          verdict: `named entity "${named}" resolved to nothing`,
        });
      }
    }

    const resolved = { person, account };

    /* -- 4. translate: model first, rules behind it -------------------- */
    let proposed = null;
    let engine = null;
    let modelNote = null;

    try {
      const out = await nl2zcql.translate(catalystApp, { question: asked, loaded, history, person });
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
      const ruled = rules.translate(asked, resolved);
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
      question: asked, rows: masked.rows, columns: result.columns,
      tables: compiled.tables, loaded, replica: result,
      // The rule that wrote the query is the most reliable statement of what
      // was asked. Shaping on columns alone once described an "active users"
      // result as "have not logged in" - the exact opposite - because both
      // queries return the same four columns.
      engine,
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

/* ================================================================ explore */

/**
 * Browse one table, for the panel that lets someone see what is actually in a
 * customer's account.
 *
 * This is a deliberate second door, and it is worth being explicit about why it
 * does not undo the PII-dump refusal that /ask enforces. /ask refuses "export
 * all contact email addresses" because that is an exfiltration shape: unmasked
 * values, whole table, one request. This endpoint keeps every guarantee that
 * refusal exists to protect -
 *
 *   scoped     ORG_ID from the grant, and only tables in the grant's service
 *   masked     the same server-side masker, before serialisation
 *   paged      a hard page ceiling, never the whole table in one response
 *   audited    every page view writes a SupportQueryLog row
 *
 * - so what it offers is orientation, not extraction. Reveal stays per-row and
 * stays audited.
 */
const EXPLORE_PAGE_MAX = 50;

app.post('/explore', async (req, res) => {
  const started = Date.now();
  const catalystApp = catalyst.initialize(req);
  let ctx = null;

  try {
    ctx = await context(catalystApp, req);
    const { claims, org, loaded } = ctx;

    const asked = String(req.body?.table ?? '').trim();
    const tableName = loaded.resolveTableName(asked);
    if (!tableName) {
      return res.status(400).json({
        error: asked
          ? `"${asked}" is not a table this session can read.`
          : 'Name a table to browse.',
        tables: loaded.tables.filter((t) => !t.internal).map((t) => t.name),
      });
    }

    const table = loaded.byTable.get(tableName);
    const size = Math.min(Math.max(Number(req.body?.page_size) || 25, 1), EXPLORE_PAGE_MAX);
    const page = Math.max(Number(req.body?.page) || 1, 1);
    const offset = (page - 1) * size;

    const columns = ['ROWID', ...table.columnNames.filter((c) => !c.endsWith('_REF'))];
    // Same two axes as the guard: the tenant, and - for the shared platform
    // tables that carry PRODUCT - the service this session was opened on.
    const scoped = serviceScope(tableName, table, org, claims, loaded);

    const zcql =
      `SELECT ${columns.map((c) => `${tableName}.${c}`).join(', ')} FROM ${tableName}${scoped.join} ` +
      `WHERE ${scoped.where} ORDER BY ${tableName}.ROWID LIMIT ${offset}, ${size}`;

    const [pageResult, countResult] = await Promise.all([
      replica.read(catalystApp, org, zcql),
      replica.read(catalystApp, org,
        `SELECT COUNT(${tableName}.ROWID) FROM ${tableName}${scoped.join} WHERE ${scoped.where} LIMIT 0, 1`),
    ]);

    const total = Number(Object.values(countResult.rows[0] ?? {})[0] ?? 0);
    const { rows, masked } = mask.maskRows(pageResult.rows, [tableName], loaded);
    const latencyMs = Date.now() - started;

    const audit = await store.logQuery(catalystApp, {
      orgId: org.ORG_ID, zgid: claims.zgid, ticketId: claims.ticketId,
      engineerId: claims.engineerId, engineerEmail: claims.engineerEmail,
      question: `[explore ${tableName} page ${page}]`,
      zcql, outcome: 'explored',
      verdict: `browsed ${tableName} rows ${offset + 1}-${offset + rows.length} of ${total}`,
      rowCount: rows.length, latencyMs,
    });

    res.json({
      table: tableName,
      label: table.label,
      describes: table.describes ?? null,
      service: claims.service,
      org_name: org.ORG_NAME,
      columns,
      rows,
      masked,
      page,
      page_size: size,
      total_rows: total,
      total_pages: Math.max(Math.ceil(total / size), 1),
      empty_reason: total === 0
        ? `No rows in ${tableName} for ${org.ORG_NAME}. The table exists but has not been populated.`
        : null,
      zcql,
      as_of: pageResult.as_of,
      replica_lag_seconds: pageResult.lag_seconds,
      dc: pageResult.dc,
      ...(audit.ok ? {} : { audit: { written: false, error: audit.error } }),
      latency_ms: latencyMs,
    });
  } catch (err) {
    if (err.name === 'GrantError') {
      return res.status(err.status ?? 401).json({ error: err.message, code: err.code });
    }
    console.error('explore failed:', err);
    res.status(500).json({ error: 'Could not read that table.' });
  }
});

/**
 * The two axes of the boundary for a browsed table: ORG_ID always, and PRODUCT
 * when the grant names a service.
 *
 * Some tables have no PRODUCT column of their own but belong to a product all
 * the same - ProfilePermissions is a grant matrix whose product is that of the
 * profile it points at. Filtering only tables with a PRODUCT column would have
 * shown a Desk session all 234 grant rows, 156 of them CRM's and Campaigns'.
 * Those are scoped through the parent: join it, pin its PRODUCT.
 *
 * Returns { join, where } so the caller can place each part of the query.
 */
function serviceScope(tableName, table, org, claims, loaded) {
  const service = claims.service && claims.service !== 'all' ? store.q(claims.service) : null;
  let where = `${tableName}.ORG_ID = '${store.q(org.ORG_ID)}'`;
  let join = '';

  if (!service) return { join, where };

  if (table.columnNames?.includes('PRODUCT')) {
    where += ` AND ${tableName}.PRODUCT = '${service}'`;
    return { join, where };
  }

  const viaParent = (table.refs ?? []).find((r) => loaded?.byTable?.get(r.parent)?.columnNames?.includes('PRODUCT'));
  if (viaParent) {
    join = ` INNER JOIN ${viaParent.parent} ON ${tableName}.${viaParent.column} = ${viaParent.parent}.ROWID`;
    where += ` AND ${viaParent.parent}.ORG_ID = '${store.q(org.ORG_ID)}' AND ${viaParent.parent}.PRODUCT = '${service}'`;
  }
  return { join, where };
}

/**
 * How many rows each table holds for this customer, so the browser can show
 * what is populated before anyone clicks into an empty table.
 */
app.post('/explore/summary', async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  try {
    const { org, loaded, claims } = await context(catalystApp, req);
    const tables = loaded.tables.filter((t) => !t.internal);

    const counts = await Promise.all(tables.map(async (t) => {
      try {
        const sc = serviceScope(t.name, t, org, claims, loaded);
        const out = await replica.read(catalystApp, org,
          `SELECT COUNT(${t.name}.ROWID) FROM ${t.name}${sc.join} WHERE ${sc.where} LIMIT 0, 1`);
        return { name: t.name, label: t.label, pack: t.pack, rows: Number(Object.values(out.rows[0] ?? {})[0] ?? 0) };
      } catch {
        return { name: t.name, label: t.label, pack: t.pack, rows: null };
      }
    }));

    res.json({
      org_name: org.ORG_NAME, service: claims.service,
      tables: counts,
      total_rows: counts.reduce((n, c) => n + (c.rows ?? 0), 0),
    });
  } catch (err) {
    if (err.name === 'GrantError') {
      return res.status(err.status ?? 401).json({ error: err.message, code: err.code });
    }
    console.error('explore summary failed:', err);
    res.status(500).json({ error: 'Could not summarise the tables.' });
  }
});

app.get('/audit', async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const orgId = String(req.query.org_id ?? '').trim();
  try {
    const rows = orgId
      ? await store.recentLog(catalystApp, orgId, Number(req.query.limit) || 100)
      : await store.fullLog(catalystApp, Number(req.query.limit) || 300);
    // Entries still in the spool are part of the trail and must be visible
    // here, or a reviewer would read "no record" for a question that was
    // recorded a moment ago. They are marked pending so the two are never
    // confused.
    let pending = [];
    try {
      pending = (await spool.list(catalystApp, 200))
        .map(({ row }) => ({ ...row, PENDING: true }))
        .filter((r) => !orgId || r.ORG_ID === orgId);
    } catch { /* the table's own rows are still worth returning */ }

    const log = [...pending.reverse(), ...rows];
    const byOutcome = log.reduce((acc, r) => {
      acc[r.OUTCOME] = (acc[r.OUTCOME] ?? 0) + 1;
      return acc;
    }, {});
    res.json({
      count: log.length,
      in_table: rows.length,
      pending_in_spool: pending.length,
      by_outcome: byOutcome,
      log,
    });
  } catch (err) {
    console.error('/audit failed:', err);
    res.status(500).json({ error: 'Could not read the audit log.' });
  }
});

/* ================================================================== admin */

/**
 * Move spooled audit entries into SupportQueryLog.
 *
 * Bulk write, because that is the meter that still works. Entries are deleted
 * only after the job reports Completed - a drain that deleted first and failed
 * second would destroy the very records it exists to protect.
 */
app.post('/admin/audit-drain', async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'Admin token required.' });
  const started = Date.now();
  const catalystApp = catalyst.initialize(req);

  try {
    const entries = await spool.list(catalystApp, Number(req.body?.limit) || 200);
    if (!entries.length) {
      return res.json({ ok: true, drained: 0, note: 'Spool is empty.', ms: Date.now() - started });
    }

    const rows = entries.map((e) => e.row);
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const csv = [columns.join(',')]
      .concat(rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')))
      .join('\n');

    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), `audit-drain-${Date.now()}.csv`);
    fs.writeFileSync(tmp, csv, 'utf8');

    let uploaded;
    try {
      uploaded = await catalystApp.filestore().folder(SEED_CSV_FOLDER).uploadFile({
        code: fs.createReadStream(tmp), name: 'SupportQueryLog.csv',
      });
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }

    const table = catalystApp.datastore().table('SupportQueryLog');
    const job = await table.bulkJob('write').createJob(String(uploaded.id), { operation: 'insert' });

    // Poll briefly. Deleting before the rows land would lose them outright.
    let status = job.status;
    for (let i = 0; i < 12 && status === 'In-Progress'; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      status = (await table.bulkJob('write').getStatus(job.job_id)).status;
    }

    if (status !== 'Completed') {
      return res.json({
        ok: false, drained: 0, job_id: job.job_id, status,
        note: 'Rows not confirmed yet - nothing deleted. Re-run to retry.',
        ms: Date.now() - started,
      });
    }

    const removed = await spool.remove(catalystApp, entries.map((e) => e.key));
    res.json({
      ok: true, drained: rows.length, removed_from_spool: removed,
      job_id: job.job_id, status, ms: Date.now() - started,
    });
  } catch (err) {
    console.error('audit drain failed:', err);
    res.status(500).json({ ok: false, error: err.message, ms: Date.now() - started });
  }
});



function adminOk(req) {
  const expected = process.env.ASKDATA_ADMIN_TOKEN;
  return Boolean(expected) && req.get('x-askdata-admin') === expected;
}

/**
 * Seed by BULK WRITE instead of row inserts.
 *
 * Row-by-row `insertRow` is metered as "Datastore - Insert", and that free-tier
 * allowance is exhausted on this project. Bulk write takes a CSV through File
 * Store and may be metered differently - so this exists to find out, and to be
 * the loading path if it is.
 *
 * Foreign keys are deliberately left out of the CSV. The _REF columns are
 * resolved afterwards by /admin/provision-refs, which uses UPDATE - a different
 * operation again, and one that is known to still work here.
 */
const SEED_CSV_FOLDER = process.env.ASKDATA_SEED_FOLDER_ID || '30663000000140379';

/** RFC4180-ish: quote everything, double the quotes. Empty stays empty. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  return `"${String(value).replace(/"/g, '""')}"`;
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return lines.join('\n');
}

app.post('/admin/bulk-seed', async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'Admin token required.' });

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const seed = require('./lib/seed');

  const started = Date.now();
  const catalystApp = catalyst.initialize(req);
  const wanted = String(req.body?.table ?? '').trim();
  const stage = String(req.body?.only ?? '').trim();

  try {
    if (req.body?.audit_per_org) {
      seed.AUDIT_PER_ORG.value = Math.max(1, Math.min(2000, Number(req.body.audit_per_org)));
    }

    // Build only what was asked for, so a failure is attributable to one table.
    const built = {};
    for (const [name, build] of Object.entries(seed.STAGES)) {
      if (stage && name !== stage) continue;
      Object.assign(built, build());
    }
    const tables = wanted ? [wanted] : Object.keys(built);

    const wipe = req.body?.wipe === true;
    const results = [];
    for (const table of tables) {
      const rows = built[table];
      if (!rows?.length) { results.push({ table, skipped: 'no rows generated' }); continue; }

      // Replace rather than append: a second load would otherwise duplicate
      // every row. Deletes are ZCQL and are metered separately from inserts,
      // which is why this works while row-by-row seeding does not.
      let wiped = null;
      if (wipe) {
        await seed.wipeTable(catalystApp, table);
        wiped = true;
      }

      // Business columns only. _REF foreign keys are filled in afterwards.
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !c.endsWith('_REF'));
      const csv = toCsv(rows, columns);

      const tmp = path.join(os.tmpdir(), `${table}-${Date.now()}.csv`);
      fs.writeFileSync(tmp, csv, 'utf8');

      let uploaded;
      try {
        uploaded = await catalystApp.filestore().folder(SEED_CSV_FOLDER).uploadFile({
          code: fs.createReadStream(tmp), name: `${table}.csv`,
        });
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      }

      const job = await catalystApp.datastore().table(table)
        .bulkJob('write')
        .createJob(String(uploaded.id), { operation: 'insert' });

      results.push({
        table, rows: rows.length, columns: columns.length, wiped,
        file_id: String(uploaded.id), job_id: job.job_id, status: job.status,
      });
    }

    res.json({ ok: true, results, ms: Date.now() - started });
  } catch (err) {
    console.error('bulk seed failed:', err);
    res.status(500).json({ ok: false, error: err.message, ms: Date.now() - started });
  }
});

app.get('/admin/bulk-status', async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'Admin token required.' });
  const catalystApp = catalyst.initialize(req);
  const table = String(req.query.table ?? '').trim();
  const jobId = String(req.query.job ?? '').trim();
  if (!table || !jobId) return res.status(400).json({ error: 'Pass table and job.' });

  try {
    const status = await catalystApp.datastore().table(table).bulkJob('write').getStatus(jobId);
    res.json({
      job_id: status.job_id, status: status.status,
      details: status.results ?? status.query ?? null,
      more: status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/seed', async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'Admin token required.' });
  const started = Date.now();
  try {
    const out = await require('./lib/seed').seed(catalyst.initialize(req), {
      only: req.body?.only ?? null,
      wipe: req.body?.wipe !== false,
      auditPerOrg: req.body?.audit_per_org ?? null,
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
