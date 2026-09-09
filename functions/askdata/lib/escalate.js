'use strict';

/**
 * The escalation path.
 *
 * This is what makes AskData safe to adopt. When it cannot answer - an
 * unsupported join, a module with no pack, a question it does not understand -
 * it must not dead-end. It hands the debug engineer the query they would have
 * written anyway plus a note explaining what is needed. Worst case, the tool
 * still saves them the reading time.
 *
 * A tool that fails to *nothing* is abandoned after the third failure. A tool
 * that fails to a draft is still doing work.
 *
 * NOTE THE AUDIENCE SWITCH. `lib/answer.js` writes for the customer and must
 * never contain a query. This file writes for a Zoho debug engineer, so ZCQL is
 * exactly what belongs in it. The two must not be confused: `escalation_draft`
 * is an internal note, `ticket_comment` is a customer reply.
 */

const rules = require('./rules');

/** A best-effort query for a debug engineer to run, with scoping spelled out. */
function draftQuery({ question, orgId, zgid, resolved = {}, loaded }) {
  const ruled = rules.translate(question, resolved);
  if (ruled) {
    // Show it scoped, because an unscoped query is not runnable against a
    // shared store and the debug engineer would have to add it themselves.
    return {
      zcql: withScope(ruled.zcql, orgId),
      basis: `matched the "${ruled.ruleId}" pattern`,
    };
  }

  const tables = (loaded?.tables ?? []).slice(0, 4).map((t) => t.name).join(', ');
  return {
    zcql:
      `-- AskData could not turn this into a query.\n` +
      `-- Question: ${String(question).replace(/\n/g, ' ')}\n` +
      `-- Org: ${orgId} (zgid ${zgid})\n` +
      `-- Tables available for this customer: ${tables}${tables ? ', …' : ''}\n` +
      `SELECT /* columns */ FROM /* table */ WHERE ORG_ID = '${orgId}' LIMIT 0, 200`,
    basis: 'no pattern matched - skeleton only',
  };
}

/** Add ORG_ID scoping to a draft, the same way the guard would. */
function withScope(zcql, orgId) {
  const tables = [...String(zcql).matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((m) => m[1]);
  const scope = [...new Set(tables)].map((t) => `${t}.ORG_ID = '${orgId}'`).join(' AND ');
  if (!scope) return zcql;
  return /\bWHERE\b/i.test(zcql)
    ? zcql.replace(/\bWHERE\b/i, `WHERE ${scope} AND `)
    : `${zcql} WHERE ${scope}`;
}

/**
 * Build the escalation.
 *
 * `reason` is why AskData stopped - the guard's plain reason, or a description
 * of what it could not understand. It goes into the note so the debug engineer
 * knows whether this is "the tool cannot express this" or "the tool does not
 * have this module".
 */
function build({ question, reason, orgId, zgid, ticketId, engineerEmail, resolved, loaded, orgName }) {
  const { zcql, basis } = draftQuery({ question, orgId, zgid, resolved, loaded });

  const note = [
    `AskData could not answer this one, passing it over.`,
    ``,
    `Customer   : ${orgName ?? orgId} (ZGID ${zgid})`,
    `Ticket     : ${ticketId}`,
    `Raised by  : ${engineerEmail}`,
    `Question   : ${String(question).replace(/\n/g, ' ')}`,
    `Why not    : ${reason}`,
    `Draft basis: ${basis}`,
    ``,
    `Suggested query:`,
    zcql,
    ``,
    `Please paste the result back on the ticket and we will relay it to the customer.`,
  ].join('\n');

  return { zcql, ticket_comment: note, basis };
}

module.exports = { build, draftQuery, withScope };
