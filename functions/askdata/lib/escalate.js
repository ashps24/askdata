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
  const ruled = rules.translate(question, { ...resolved, loaded });
  const service = loaded?.serviceKey && loaded.serviceKey !== 'all' ? loaded.serviceKey : null;

  if (ruled) {
    // A draft is handed to a debug engineer to RUN. The guard never sees it,
    // so the session boundary has to be applied here or a Desk escalation
    // walks out carrying a runnable CRM_Leads query. Two checks, same as the
    // guard's: every table must be one this session loaded, and no literal may
    // name another service's product.
    const tables = [...String(ruled.zcql).matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]);
    const foreignTable = tables.find((t) => !loaded?.tableNames?.includes(t));
    const foreignKey = service
      ? [...String(ruled.zcql).matchAll(/\bPERMISSION_KEY\s*=\s*'([a-z]+)\./gi)].map((m) => m[1]).find((p) => p !== service)
      : null;

    if (!foreignTable && !foreignKey) {
      // Show it scoped, because an unscoped query is not runnable against a
      // shared store and the debug engineer would have to add it themselves.
      return {
        zcql: withScope(ruled.zcql, orgId, loaded),
        basis: `matched the "${ruled.ruleId}" pattern`,
      };
    }

    const other = foreignKey ?? (foreignTable ? foreignTable.split('_')[0].toLowerCase() : 'another service');
    return {
      zcql:
        `-- Not drafted: this question is about ${other}, and this session is scoped to ${service ?? 'the loaded services'}.\n` +
        `-- Question: ${String(question).replace(/\n/g, ' ')}\n` +
        `-- Org: ${orgId} (zgid ${zgid})\n` +
        `-- Open a ${other} session for this customer and escalate from there.`,
      basis: `out of scope for this session (${other})`,
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

/**
 * Add ORG_ID scoping to a draft, the same way the guard would - and PRODUCT
 * scoping on the shared platform tables when the session names a service, so
 * a debug engineer handed a Desk escalation is not handed a query that would
 * also read CRM permissions.
 */
function withScope(zcql, orgId, loaded = null) {
  const tables = [...String(zcql).matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((m) => m[1]);
  const service = loaded?.serviceKey && loaded.serviceKey !== 'all' ? loaded.serviceKey : null;
  const scope = [...new Set(tables)]
    .flatMap((t) => [
      `${t}.ORG_ID = '${orgId}'`,
      ...(service && loaded.byTable?.get(t)?.columnNames?.includes('PRODUCT') ? [`${t}.PRODUCT = '${service}'`] : []),
    ])
    .join(' AND ');
  if (!scope) return zcql;
  if (/\bWHERE\b/i.test(zcql)) {
    return zcql.replace(/\bWHERE\b/i, `WHERE ${scope} AND `);
  }
  // A WHERE cannot simply be appended: the draft may already end in GROUP BY,
  // ORDER BY or LIMIT, and `... ORDER BY x WHERE ...` is not a query. Insert it
  // ahead of the first trailing clause instead.
  const tail = /\s+(GROUP\s+BY|ORDER\s+BY|LIMIT)\b/i.exec(zcql);
  return tail
    ? `${zcql.slice(0, tail.index)} WHERE ${scope}${zcql.slice(tail.index)}`
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
    ...(loaded?.serviceKey && loaded.serviceKey !== 'all' ? [`Service    : ${loaded.serviceLabel ?? loaded.serviceKey} (this session only)`] : []),
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
