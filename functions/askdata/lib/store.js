'use strict';

/**
 * AskData's own tables: the org registry, the entitlement check, and the audit
 * log. All read and written directly by the server - none of them is in the
 * query allow-list, so a generated query can never reach them.
 */

const { flattenRows } = require('./replica');

const q = (v) => String(v ?? '').replace(/'/g, "''");
const clip = (v, n) => {
  const s = v === null || v === undefined ? '' : String(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** IST wall-clock, matching every other datetime in the app. See lib/time.js. */
const { istNaive } = require('./time');
const nowStamp = () => istNaive();

/* ---------------------------------------------------------------- registry */

const ORG_COLUMNS =
  'ORG_ID, ZGID, ORG_NAME, DC, EDITION, SUBSCRIBED_PRODUCTS, STATUS, SIGNED_UP_ON, ' +
  'CRM_ORG_ID, CMP_ORG_ID, DESK_ORG_ID';

/** Which Orgs column holds the org id a ticket for this service would quote. */
const SERVICE_COLUMN = { crm: 'CRM_ORG_ID', campaigns: 'CMP_ORG_ID', desk: 'DESK_ORG_ID' };

async function findOrgByZgid(catalystApp, zgid) {
  const result = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ${ORG_COLUMNS} FROM Orgs WHERE ZGID = '${q(zgid)}' LIMIT 1`
  );
  return flattenRows(result)[0] ?? null;
}

/**
 * Find a company by the org id printed on a ticket for one specific service.
 *
 * A customer is one company but several org ids - the CRM org id, the Campaigns
 * org id and the Desk portal id are different numbers. The engineer types
 * whichever is in front of them, so the id is looked up in that service's own
 * column. Matching across every column instead would let a Desk portal id open
 * a CRM session, which is precisely the confusion this is meant to remove.
 */
async function findOrgByServiceId(catalystApp, service, serviceOrgId) {
  const column = SERVICE_COLUMN[String(service ?? '').toLowerCase()];
  if (!column) return null;
  const result = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ${ORG_COLUMNS} FROM Orgs WHERE ${column} = '${q(serviceOrgId)}' LIMIT 1`
  );
  return flattenRows(result)[0] ?? null;
}

async function listOrgs(catalystApp) {
  const result = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ${ORG_COLUMNS} FROM Orgs ORDER BY ORG_NAME LIMIT 0, 50`
  );
  return flattenRows(result);
}

/* ------------------------------------------------------------- entitlement */

/**
 * Is this engineer entitled to this org right now?
 *
 * Two ways in, both time-bound:
 *   - an OPEN ticket for that org, matching the ticket the engineer typed
 *   - an active elevated-access grant covering now
 *
 * An engineer with no live reason to be in an org is refused. In production this
 * reads the ticketing system and the access-grant service; the table is the
 * seam. Note the ticket must match: holding a ticket for org A does not entitle
 * you to org B, and neither does a closed one.
 */
async function entitlementFor(catalystApp, { engineerEmail, zgid, ticketId }) {
  const result = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ENTITLEMENT_ID, ORG_ID, ENGINEER_EMAIL, ZGID, TICKET_ID, KIND, TICKET_STATUS, ` +
    `VALID_FROM, VALID_UNTIL FROM SupportEntitlements ` +
    `WHERE ENGINEER_EMAIL = '${q(engineerEmail)}' AND ZGID = '${q(zgid)}' LIMIT 0, 50`
  );
  const rows = flattenRows(result);
  const now = nowStamp();

  const openTicket = rows.find(
    (r) => r.KIND === 'open_ticket' &&
      String(r.TICKET_STATUS).toLowerCase() === 'open' &&
      String(r.TICKET_ID) === String(ticketId)
  );
  if (openTicket) return { ...openTicket, via: 'open ticket' };

  const elevated = rows.find(
    (r) => r.KIND === 'elevated_access' &&
      (!r.VALID_FROM || String(r.VALID_FROM) <= now) &&
      (!r.VALID_UNTIL || String(r.VALID_UNTIL) >= now)
  );
  if (elevated) return { ...elevated, via: 'elevated access' };

  return null;
}

/**
 * Every live entitlement this engineer holds, keyed by ZGID.
 *
 * Their own access, not anyone else's, so surfacing it leaks nothing: it is
 * the same list their ticket queue would show. It exists because the commonest
 * connect failure is not a missing entitlement at all - it is last customer's
 * ticket still sitting in the box while a new customer is selected, which the
 * server can only report as "no live reason to open this customer".
 */
async function myEntitlements(catalystApp, engineerEmail) {
  const result = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ORG_ID, ZGID, TICKET_ID, KIND, TICKET_STATUS, VALID_FROM, VALID_UNTIL ` +
    `FROM SupportEntitlements WHERE ENGINEER_EMAIL = '${q(engineerEmail)}' LIMIT 0, 200`
  );
  const now = nowStamp();
  const byZgid = new Map();

  for (const row of flattenRows(result)) {
    const live =
      row.KIND === 'open_ticket'
        ? String(row.TICKET_STATUS).toLowerCase() === 'open'
        : (!row.VALID_FROM || String(row.VALID_FROM) <= now) &&
          (!row.VALID_UNTIL || String(row.VALID_UNTIL) >= now);
    if (!live) continue;

    if (!byZgid.has(row.ZGID)) byZgid.set(row.ZGID, { open_tickets: [], elevated: false });
    const entry = byZgid.get(row.ZGID);
    if (row.KIND === 'elevated_access') entry.elevated = true;
    else entry.open_tickets.push(String(row.TICKET_ID));
  }
  return byZgid;
}

/**
 * Which customer does a ticket the engineer holds actually belong to?
 * Used only to improve a refusal, and only across tickets they are already
 * entitled to - so it tells them nothing they could not already see.
 */
async function ticketBelongsTo(catalystApp, engineerEmail, ticketId) {
  const entitlements = await myEntitlements(catalystApp, engineerEmail);
  for (const [zgid, entry] of entitlements) {
    if (entry.open_tickets.includes(String(ticketId))) return zgid;
  }
  return null;
}

/* -------------------------------------------------------------- audit log */

let logSeq = 0;

/**
 * Write one `SupportQueryLog` row.
 *
 * Never throws. A question that was answered correctly must not turn into a 500
 * because the audit write timed out - but a failure is loud in the function log,
 * because a silently incomplete audit trail is worse than a noisy one.
 */
async function logQuery(catalystApp, entry) {
  const row = {
    ORG_ID: clip(entry.orgId, 64),
    LOG_ID: clip(entry.logId ?? `L-${Date.now()}-${++logSeq}`, 40),
    ENGINEER_ID: clip(entry.engineerId, 64),
    ENGINEER_EMAIL: clip(entry.engineerEmail, 200),
    TICKET_ID: clip(entry.ticketId, 32),
    ZGID: clip(entry.zgid, 32),
    QUESTION: clip(entry.question, 255),   // varchar caps at 255
    GENERATED_ZCQL: clip(entry.zcql, 9000),
    GUARD_VERDICT: clip(entry.verdict, 200),
    ROW_COUNT: Number.isFinite(entry.rowCount) ? entry.rowCount : 0,
    LATENCY_MS: Number.isFinite(entry.latencyMs) ? entry.latencyMs : 0,
    OUTCOME: clip(entry.outcome, 20),
    PII_REVEALED: clip(entry.piiRevealed, 200),
    OCCURRED_AT: nowStamp(),
  };

  // A security-relevant refusal is worth an alert, not just a row.
  if (entry.security) {
    console.error(
      `[SECURITY] askdata ${entry.outcome}: engineer=${row.ENGINEER_EMAIL} zgid=${row.ZGID} ` +
      `ticket=${row.TICKET_ID} verdict=${row.GUARD_VERDICT} question=${JSON.stringify(row.QUESTION)}`
    );
  }

  try {
    await catalystApp.datastore().table('SupportQueryLog').insertRow(row);
    return { ok: true, logId: row.LOG_ID };
  } catch (err) {
    // "Every query is audited" is one of this tool's four guarantees, so an
    // audit write that fails is a security event in its own right - not a
    // warning to bury. It was buried once: an exhausted insert quota stopped
    // the log dead while answers kept flowing, and nothing said so.
    console.error(
      `[SECURITY] askdata AUDIT WRITE FAILED: ${err.message} :: ` +
      `${JSON.stringify(row).slice(0, 400)}`
    );
    return { ok: false, logId: null, error: err.message };
  }
}

/**
 * Must an unauditable query be refused?
 *
 * Yes in production: answering without a trail is the one thing the tool
 * promises it cannot do. No in development, where the alternative is an app
 * that cannot be demonstrated because a free-tier counter ran out - and where
 * the response carries the warning instead.
 */
function requireAudit() {
  const explicit = process.env.ASKDATA_REQUIRE_AUDIT;
  if (explicit !== undefined) return String(explicit).toLowerCase() === 'true';
  return process.env.ASKDATA_ENV === 'Production';
}

/** The audit trail for one org, newest first. */
async function recentLog(catalystApp, orgId, count = 100) {
  const limit = Math.min(Math.max(Number(count) || 100, 1), 300);
  const result = await catalystApp.zcql().executeZCQLQuery(
    `SELECT LOG_ID, ENGINEER_EMAIL, TICKET_ID, ZGID, QUESTION, GENERATED_ZCQL, GUARD_VERDICT, ` +
    `ROW_COUNT, LATENCY_MS, OUTCOME, PII_REVEALED, OCCURRED_AT FROM SupportQueryLog ` +
    `WHERE ORG_ID = '${q(orgId)}' ORDER BY OCCURRED_AT DESC LIMIT 0, ${limit}`
  );
  return flattenRows(result);
}

/** Everything logged, across orgs - for the audit verification step. */
async function fullLog(catalystApp, count = 300) {
  const limit = Math.min(Math.max(Number(count) || 300, 1), 300);
  const result = await catalystApp.zcql().executeZCQLQuery(
    `SELECT LOG_ID, ORG_ID, ZGID, ENGINEER_EMAIL, TICKET_ID, QUESTION, GUARD_VERDICT, ` +
    `ROW_COUNT, OUTCOME, PII_REVEALED, LATENCY_MS, OCCURRED_AT FROM SupportQueryLog ` +
    `ORDER BY OCCURRED_AT DESC LIMIT 0, ${limit}`
  );
  return flattenRows(result);
}

module.exports = {
  requireAudit, findOrgByServiceId, SERVICE_COLUMN, myEntitlements, ticketBelongsTo, findOrgByZgid, listOrgs, entitlementFor, logQuery, recentLog, fullLog, nowStamp, q };
