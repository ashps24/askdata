'use strict';

/**
 * Deterministic question -> ZCQL, and the intent checks that come before it.
 *
 * This exists so AskData always does something defensible. The model is the
 * primary translator, but it sits behind a network call to a service that can
 * be slow, refuse, or be unprovisioned in a given project - and a support tool
 * that says "try again" gets abandoned after the third failure.
 *
 * Order of business, and each step can end the request:
 *
 *   1. mutation intent   - a question that asks to CHANGE something never
 *                          becomes a query. Rule 1 is absolute.
 *   2. off-topic         - nothing to do with the customer's data -> clarify
 *   3. a matching rule   - the escalation patterns, written out
 *
 * Every rule omits ORG_ID: the guard injects tenant scoping for both engines,
 * so it lives in exactly one place and the two paths cannot disagree.
 *
 * Rules also omit LIKE entirely and join only on declared `_REF` columns,
 * because both are engine constraints rather than preferences - see lib/guard.js.
 */

const any = (...terms) => (q) => terms.some((t) => q.includes(t));
const all = (...preds) => (q) => preds.every((p) => p(q));

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

/* --------------------------------------------------- 1. mutation intent */

/**
 * Does this question ask for a CHANGE?
 *
 * Checked on the question, before any translation, because rule 1 is not a
 * guard concern - it is a product boundary. A support engineer looking at a
 * customer's live production data must not have a path that mutates it: every
 * misunderstood question would become a customer-visible incident, and the tool
 * itself would become an insider-risk surface. Fixes go through the debug
 * engineer, who has change control, review and a rollback story.
 */
const MUTATION = [
  /\b(delete|remove|drop|purge|wipe|clear)\b.*\b(lead|leads|contact|contacts|user|users|record|records|deal|deals|ticket|tickets|all)\b/,
  /\b(set|change|update|edit|modify|fix|correct|reset|revert|restore)\b.*\b(to|back to|as|=)\b/,
  /\b(add|create|assign|grant|enable|disable|deactivate|activate|suspend)\b.*\b(user|users|permission|profile|licence|license|department|segment)\b/,
  /\bcan you (please )?(change|set|update|fix|delete|remove|add|grant|enable|disable)\b/,
  /\bmerge\b|\bbulk update\b|\bmass delete\b/,
];

function mutationIntent(question) {
  const q = String(question ?? '').toLowerCase();
  return MUTATION.some((re) => re.test(q));
}

/* ------------------------------------------------------- 2. off topic */

/** Words that mean the question is about the customer's data at all. */
const ON_TOPIC = [
  'lead', 'contact', 'account', 'deal', 'pipeline', 'export', 'source', 'user',
  'profile', 'permission', 'segment', 'list', 'campaign', 'department', 'ticket',
  'login', 'log in', 'audit', 'activity', 'licence', 'license', 'stage', 'field',
  'history', 'changed', 'member', 'agent', 'employee', 'staff', 'record', 'org',
  'admin', 'access', 'role', 'email', 'phone', 'company',
];

function offTopic(question) {
  const q = String(question ?? '').toLowerCase();
  return !ON_TOPIC.some((w) => q.includes(w));
}

/* ---------------------------------------------------------- extraction */

/** A long numeric id, as customers quote them in tickets. */
function leadIdIn(question) {
  return /\b(\d{10,})\b/.exec(String(question ?? ''))?.[1] ?? null;
}

function daysIn(question, fallback = 30) {
  const m = /(\d{1,4})\s*(?:day|days)\b/i.exec(String(question ?? ''));
  return m ? Number(m[1]) : fallback;
}

/** A date literal `days` ago, in Data Store's datetime shape. */
function daysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** "should be in the Escalations department" -> "Escalations" */
function expectedDepartment(question) {
  const m =
    /\bshould be (?:in|part of|a member of)\s+(?:the\s+)?([A-Za-z][\w &'-]{1,40}?)(?:\s+(?:department|dept|team|queue))?\b/i
      .exec(String(question ?? ''));
  return m ? m[1].trim() : null;
}

/** Module + action -> a permission key that exists in the catalog. */
const MODULES = [
  ['segment', 'campaigns', 'Segments'], ['list', 'campaigns', 'Lists'],
  ['campaign', 'campaigns', 'Campaigns'],
  ['lead', 'crm', 'Leads'], ['contact', 'crm', 'Contacts'],
  ['account', 'crm', 'Accounts'], ['deal', 'crm', 'Deals'],
  ['ticket', 'desk', 'Tickets'], ['department', 'desk', 'Departments'],
];
const ACTIONS = [
  ['create', 'create'], ['add', 'create'], ['make', 'create'], ['new', 'create'],
  ['delete', 'delete'], ['remove', 'delete'],
  ['edit', 'edit'], ['update', 'edit'], ['change', 'edit'], ['modify', 'edit'],
  ['export', 'export'], ['download', 'export'],
  ['share', 'share'], ['approve', 'approve'],
  ['view', 'view'], ['see', 'view'], ['read', 'view'], ['access', 'view'], ['open', 'view'],
];

function permissionTarget(question) {
  const q = String(question ?? '').toLowerCase();
  const mod = MODULES.find(([w]) => q.includes(w));
  const act = ACTIONS.find(([w]) => q.includes(w));
  if (!mod || !act) return null;
  return { product: mod[1], module: mod[2], action: act[1], key: `${mod[1]}.${mod[2].toLowerCase()}.${act[1]}` };
}

/* -------------------------------------------------------------- 3. rules */

/** Users -> Profiles -> ProfilePermissions -> Permissions. Exactly 4 joins. */
const PERMISSION_CHAIN =
  'FROM UserProfiles ' +
  'INNER JOIN Users ON UserProfiles.USER_REF = Users.ROWID ' +
  'INNER JOIN Profiles ON UserProfiles.PROFILE_REF = Profiles.ROWID ' +
  'INNER JOIN ProfilePermissions ON ProfilePermissions.PROFILE_REF = Profiles.ROWID ' +
  'INNER JOIN Permissions ON ProfilePermissions.PERMISSION_REF = Permissions.ROWID ';

const RULES = [
  /* -- the opening escalation: one lead's source ---------------------- */
  {
    id: 'lead-source-by-id',
    // "who changed the source on lead X" also mentions the source, but wants
    // the history rather than the current value - so it is excluded here and
    // handled by field-history-for-lead below.
    when: (q, ctx) =>
      Boolean(ctx.leadId) &&
      any('source', 'origin', 'came from', 'where did')(q) &&
      !any('who changed', 'who edited', 'who set', 'changed', 'history', 'before', 'previous')(q),
    build: (q, ctx) =>
      'SELECT CRM_Leads.LEAD_ID, CRM_Leads.LEAD_SOURCE, CRM_Leads.LEAD_STATUS, ' +
      'CRM_Leads.COMPANY, CRM_Leads.CREATED_ON, CRM_Leads.MODIFIED_ON ' +
      `FROM CRM_Leads WHERE CRM_Leads.LEAD_ID = ${lit(ctx.leadId)}`,
  },
  {
    id: 'field-history-for-lead',
    when: (q, ctx) => Boolean(ctx.leadId) && any('who changed', 'who edited', 'change', 'changed', 'history', 'before')(q),
    build: (q, ctx) =>
      'SELECT CRM_FieldHistory.CHANGED_AT, CRM_FieldHistory.FIELD_NAME, CRM_FieldHistory.OLD_VALUE, ' +
      'CRM_FieldHistory.NEW_VALUE, Users.FULL_NAME FROM CRM_FieldHistory ' +
      'LEFT JOIN Users ON CRM_FieldHistory.CHANGED_BY_REF = Users.ROWID ' +
      `WHERE CRM_FieldHistory.RECORD_ID = ${lit(ctx.leadId)} ` +
      'ORDER BY CRM_FieldHistory.CHANGED_AT DESC',
  },
  {
    id: 'lead-by-id',
    when: (q, ctx) => Boolean(ctx.leadId) && any('lead', 'record')(q),
    build: (q, ctx) =>
      'SELECT CRM_Leads.LEAD_ID, CRM_Leads.LEAD_SOURCE, CRM_Leads.LEAD_STATUS, CRM_Leads.COMPANY, ' +
      'CRM_Leads.CONVERTED, CRM_Leads.CREATED_ON, CRM_Leads.MODIFIED_ON ' +
      `FROM CRM_Leads WHERE CRM_Leads.LEAD_ID = ${lit(ctx.leadId)}`,
  },

  /* -- the security escalation: did this person export data? ---------- */
  {
    id: 'person-exports',
    when: (q, ctx) => Boolean(ctx.person) && any('export', 'download', 'took data', 'exfiltrat', 'extract')(q),
    build: (q, ctx) =>
      'SELECT CRM_ExportJobs.EXPORTED_AT, CRM_ExportJobs.MODULE, CRM_ExportJobs.ROW_COUNT, ' +
      'CRM_ExportJobs.FILTER_APPLIED, CRM_ExportJobs.FORMAT, CRM_ExportJobs.IP_ADDRESS, ' +
      'CRM_ExportJobs.STATUS FROM CRM_ExportJobs ' +
      `WHERE CRM_ExportJobs.USER_ID = ${lit(ctx.person.USER_ID)} ` +
      'ORDER BY CRM_ExportJobs.ROW_COUNT DESC',
  },
  {
    id: 'all-exports',
    // "export all contact emails" is not a question about export jobs - it is a
    // request for the contact list. It must reach contact-emails-dump below so
    // the guard refuses it visibly.
    when: (q) =>
      any('export', 'download')(q) &&
      any('who', 'any', 'all', 'list', 'recent')(q) &&
      !all(any('contact'), any('email', 'address'))(q),
    build: () =>
      'SELECT CRM_ExportJobs.EXPORTED_AT, CRM_ExportJobs.MODULE, CRM_ExportJobs.ROW_COUNT, ' +
      'CRM_ExportJobs.FILTER_APPLIED, CRM_ExportJobs.IP_ADDRESS, Users.FULL_NAME ' +
      'FROM CRM_ExportJobs LEFT JOIN Users ON CRM_ExportJobs.USER_REF = Users.ROWID ' +
      "WHERE CRM_ExportJobs.STATUS = 'completed' ORDER BY CRM_ExportJobs.ROW_COUNT DESC",
  },

  /* -- the permission escalation -------------------------------------- */
  {
    id: 'person-permission-specific',
    when: (q, ctx) => Boolean(ctx.person) && Boolean(ctx.permission),
    build: (q, ctx) =>
      'SELECT Users.FULL_NAME, Profiles.PROFILE_NAME, Profiles.PRODUCT, ' +
      'Permissions.PERMISSION_KEY, ProfilePermissions.GRANTED ' + PERMISSION_CHAIN +
      `WHERE Users.USER_ID = ${lit(ctx.person.USER_ID)} ` +
      `AND Permissions.PERMISSION_KEY = ${lit(ctx.permission.key)}`,
  },
  {
    id: 'person-permissions-all',
    when: (q, ctx) => Boolean(ctx.person) && any('permission', 'privilege', 'access', 'can they', 'what can', 'allowed')(q),
    build: (q, ctx) =>
      'SELECT Profiles.PROFILE_NAME, Profiles.PRODUCT, Permissions.PERMISSION_KEY, ' +
      'ProfilePermissions.GRANTED ' + PERMISSION_CHAIN +
      `WHERE Users.USER_ID = ${lit(ctx.person.USER_ID)} AND ProfilePermissions.GRANTED = 'true' ` +
      'ORDER BY Permissions.PERMISSION_KEY',
  },
  {
    id: 'profiles-with-action',
    when: (q, ctx) => any('profile', 'role')(q) && Boolean(ctx.permission),
    build: (q, ctx) =>
      'SELECT Profiles.PROFILE_NAME, Profiles.PRODUCT, Permissions.MODULE, ' +
      'Permissions.PERMISSION_KEY, ProfilePermissions.GRANTED ' +
      'FROM ProfilePermissions ' +
      'INNER JOIN Profiles ON ProfilePermissions.PROFILE_REF = Profiles.ROWID ' +
      'INNER JOIN Permissions ON ProfilePermissions.PERMISSION_REF = Permissions.ROWID ' +
      `WHERE Permissions.ACTION = ${lit(ctx.permission.action)} AND ProfilePermissions.GRANTED = 'true' ` +
      'ORDER BY Profiles.PROFILE_NAME',
  },
  {
    id: 'profiles-that-can-delete',
    when: (q) => all(any('profile', 'role'), any('delete', 'remove'))(q),
    build: () =>
      'SELECT Profiles.PROFILE_NAME, Profiles.PRODUCT, Permissions.MODULE, Permissions.PERMISSION_KEY, ' +
      'ProfilePermissions.GRANTED FROM ProfilePermissions ' +
      'INNER JOIN Profiles ON ProfilePermissions.PROFILE_REF = Profiles.ROWID ' +
      'INNER JOIN Permissions ON ProfilePermissions.PERMISSION_REF = Permissions.ROWID ' +
      "WHERE Permissions.ACTION = 'delete' AND ProfilePermissions.GRANTED = 'true' " +
      'ORDER BY Profiles.PROFILE_NAME',
  },

  /* -- the Desk escalation -------------------------------------------- */
  {
    id: 'person-departments',
    when: (q, ctx) => Boolean(ctx.person) && any('department', 'dept', 'team', 'queue')(q),
    build: (q, ctx) =>
      'SELECT DESK_Departments.DEPARTMENT_NAME, DESK_DepartmentMembers.ROLE_IN_DEPT, ' +
      'DESK_DepartmentMembers.ADDED_ON FROM DESK_DepartmentMembers ' +
      'INNER JOIN DESK_Departments ON DESK_DepartmentMembers.DEPARTMENT_REF = DESK_Departments.ROWID ' +
      'INNER JOIN Users ON DESK_DepartmentMembers.USER_REF = Users.ROWID ' +
      `WHERE Users.USER_ID = ${lit(ctx.person.USER_ID)} ` +
      'ORDER BY DESK_Departments.DEPARTMENT_NAME',
  },
  {
    id: 'list-departments',
    // "how many open tickets per department" mentions departments but is a
    // ticket question; it belongs to tickets-by-department.
    when: (q) =>
      any('department', 'dept', 'queue')(q) &&
      any('list', 'what', 'which', 'all', 'how many')(q) &&
      !any('ticket', 'case')(q),
    build: () =>
      'SELECT DESK_Departments.DEPARTMENT_NAME, DESK_Departments.IS_DEFAULT, DESK_Departments.CREATED_ON ' +
      'FROM DESK_Departments ORDER BY DESK_Departments.DEPARTMENT_NAME',
  },

  /* -- leads coverage -------------------------------------------------- */
  {
    id: 'leads-no-source',
    when: (q) => all(any('lead'), any('no source', 'blank', 'empty', 'not set', 'missing source', 'without a source'))(q),
    build: () =>
      'SELECT CRM_Leads.LEAD_ID, CRM_Leads.COMPANY, CRM_Leads.LEAD_STATUS, CRM_Leads.CREATED_ON ' +
      'FROM CRM_Leads WHERE CRM_Leads.LEAD_SOURCE IS NULL ORDER BY CRM_Leads.CREATED_ON DESC',
  },
  {
    id: 'leads-by-source',
    when: (q) => all(any('lead'), any('by source', 'break down', 'breakdown', 'per source', 'group', 'distribution'))(q),
    build: () =>
      'SELECT CRM_Leads.LEAD_SOURCE, COUNT(ROWID) FROM CRM_Leads ' +
      'GROUP BY CRM_Leads.LEAD_SOURCE ORDER BY COUNT(ROWID) DESC',
  },
  {
    id: 'count-leads',
    when: (q) => all(any('lead'), any('how many', 'count', 'number of', 'total'))(q),
    build: () => 'SELECT COUNT(ROWID) FROM CRM_Leads',
  },
  {
    id: 'leads-by-source-value',
    when: (q, ctx) => Boolean(ctx.leadSource),
    build: (q, ctx) =>
      'SELECT CRM_Leads.LEAD_ID, CRM_Leads.COMPANY, CRM_Leads.LEAD_STATUS, CRM_Leads.CREATED_ON ' +
      `FROM CRM_Leads WHERE CRM_Leads.LEAD_SOURCE = ${lit(ctx.leadSource)} ORDER BY CRM_Leads.CREATED_ON DESC`,
  },

  /* -- users coverage --------------------------------------------------- */
  {
    id: 'dormant-users',
    // Written loosely on purpose: engineers type "hasn't", "hasnt" and "has
    // not" interchangeably, and an apostrophe should not decide whether a
    // question is understood.
    when: (q) =>
      all(
        any('logged in', 'log in', 'login', 'signed in', 'sign in', 'logged'),
        any("hasn't", 'hasnt', 'has not', 'have not', 'havent', 'not ', 'never',
          'dormant', 'inactive', 'last ', 'stale', 'idle')
      )(q) ||
      // "dormant users" names no login word at all, but means exactly this.
      any('dormant', 'inactive user', 'stale user', 'idle user', 'unused account')(q),
    build: (q, ctx) =>
      'SELECT Users.FULL_NAME, Users.EMAIL, Users.STATUS, Users.LAST_LOGIN FROM Users ' +
      `WHERE Users.LAST_LOGIN < ${lit(daysAgo(ctx.days))} AND Users.STATUS = 'active' ` +
      'ORDER BY Users.LAST_LOGIN',
  },
  {
    id: 'count-users',
    when: (q) => all(any('user', 'people', 'employee', 'staff', 'seat'), any('how many', 'count', 'number of', 'total'))(q),
    build: () => "SELECT COUNT(ROWID) FROM Users WHERE Users.STATUS = 'active'",
  },
  {
    id: 'person-detail',
    when: (q, ctx) => Boolean(ctx.person) && any('who is', 'show me', 'details', 'about')(q),
    build: (q, ctx) =>
      'SELECT Users.FULL_NAME, Users.EMAIL, Users.STATUS, Users.LAST_LOGIN, Users.CREATED_ON ' +
      `FROM Users WHERE Users.USER_ID = ${lit(ctx.person.USER_ID)}`,
  },
  {
    id: 'person-activity',
    when: (q, ctx) => Boolean(ctx.person) && any('activity', 'audit', 'what did', 'history', 'did they do')(q),
    build: (q, ctx) =>
      'SELECT AuditEvents.OCCURRED_AT, AuditEvents.EVENT_TYPE, AuditEvents.PRODUCT, ' +
      'AuditEvents.MODULE, AuditEvents.DETAILS, AuditEvents.IP_ADDRESS FROM AuditEvents ' +
      `WHERE AuditEvents.USER_ID = ${lit(ctx.person.USER_ID)} ORDER BY AuditEvents.OCCURRED_AT DESC`,
  },

  /* -- contacts, accounts, deals ---------------------------------------- */
  {
    id: 'contacts-at-account',
    when: (q, ctx) => Boolean(ctx.account) && any('contact', 'person', 'people')(q),
    build: (q, ctx) =>
      'SELECT CRM_Contacts.FULL_NAME, CRM_Contacts.EMAIL, CRM_Contacts.TITLE, CRM_Accounts.ACCOUNT_NAME ' +
      'FROM CRM_Contacts INNER JOIN CRM_Accounts ON CRM_Contacts.ACCOUNT_REF = CRM_Accounts.ROWID ' +
      `WHERE CRM_Accounts.ACCOUNT_NAME = ${lit(ctx.account.ACCOUNT_NAME)} ` +
      'ORDER BY CRM_Contacts.FULL_NAME',
  },
  {
    id: 'count-contacts',
    when: (q) => all(any('contact'), any('how many', 'count', 'number of', 'total'))(q),
    build: () => 'SELECT COUNT(ROWID) FROM CRM_Contacts',
  },
  {
    id: 'pipeline-by-stage',
    when: (q) => any('pipeline', 'deal value', 'deals by', 'by stage', 'stage', 'revenue', 'forecast')(q),
    build: () =>
      'SELECT CRM_Deals.STAGE, COUNT(ROWID), SUM(CRM_Deals.AMOUNT) FROM CRM_Deals ' +
      'GROUP BY CRM_Deals.STAGE ORDER BY SUM(CRM_Deals.AMOUNT) DESC',
  },
  {
    id: 'count-deals',
    when: (q) => all(any('deal', 'opportunit'), any('how many', 'count', 'number of', 'total'))(q),
    build: () => 'SELECT COUNT(ROWID) FROM CRM_Deals',
  },

  /* -- campaigns --------------------------------------------------------- */
  {
    id: 'list-segments',
    when: (q) => any('segment')(q),
    build: () =>
      'SELECT CMP_Segments.SEGMENT_NAME, CMP_Segments.CRITERIA, CMP_Lists.LIST_NAME, CMP_Segments.CREATED_ON ' +
      'FROM CMP_Segments LEFT JOIN CMP_Lists ON CMP_Segments.LIST_REF = CMP_Lists.ROWID ' +
      'ORDER BY CMP_Segments.CREATED_ON DESC',
  },
  {
    id: 'list-campaigns',
    when: (q) => any('campaign', 'mailer', 'blast', 'open rate')(q),
    build: () =>
      'SELECT CMP_Campaigns.CAMPAIGN_NAME, CMP_Campaigns.STATUS, CMP_Campaigns.SENT_COUNT, ' +
      'CMP_Campaigns.OPEN_RATE, CMP_Campaigns.SENT_ON FROM CMP_Campaigns ' +
      'ORDER BY CMP_Campaigns.SENT_ON DESC',
  },
  {
    id: 'list-lists',
    when: (q) => any('mailing list', 'subscriber list', 'contact list', 'lists')(q),
    build: () =>
      'SELECT CMP_Lists.LIST_NAME, CMP_Lists.CONTACT_COUNT, CMP_Lists.CREATED_ON FROM CMP_Lists ' +
      'ORDER BY CMP_Lists.CONTACT_COUNT DESC',
  },

  /* -- desk tickets ------------------------------------------------------ */
  {
    id: 'tickets-by-department',
    when: (q) => all(any('ticket', 'case'), any('department', 'per', 'by', 'how many'))(q),
    build: () =>
      'SELECT DESK_Departments.DEPARTMENT_NAME, COUNT(ROWID) FROM DESK_Tickets ' +
      'INNER JOIN DESK_Departments ON DESK_Tickets.DEPARTMENT_REF = DESK_Departments.ROWID ' +
      "WHERE DESK_Tickets.STATUS <> 'Closed' " +
      'GROUP BY DESK_Departments.DEPARTMENT_NAME ORDER BY COUNT(ROWID) DESC',
  },
  {
    id: 'open-tickets',
    when: (q) => any('ticket', 'case')(q),
    build: () =>
      'SELECT DESK_Tickets.TICKET_ID, DESK_Tickets.SUBJECT, DESK_Tickets.TICKET_PRIORITY, ' +
      'DESK_Tickets.STATUS, DESK_Tickets.CREATED_ON FROM DESK_Tickets ' +
      "WHERE DESK_Tickets.STATUS <> 'Closed' ORDER BY DESK_Tickets.CREATED_ON DESC",
  },

  /* -- audit ------------------------------------------------------------- */
  {
    id: 'recent-audit',
    when: (q) => any('audit', 'activity', 'what happened', 'recent events')(q),
    build: () =>
      'SELECT AuditEvents.OCCURRED_AT, AuditEvents.EVENT_TYPE, AuditEvents.PRODUCT, ' +
      'AuditEvents.MODULE, Users.FULL_NAME FROM AuditEvents ' +
      'LEFT JOIN Users ON AuditEvents.USER_REF = Users.ROWID ' +
      "WHERE AuditEvents.EVENT_TYPE <> 'record_view' ORDER BY AuditEvents.OCCURRED_AT DESC",
  },

  /* -- the PII-dump shape, deliberately reachable ------------------------ */
  //
  // "export all contact emails" must produce the query the guard then refuses,
  // rather than being quietly rewritten into something narrower. The refusal is
  // the correct product behaviour and it needs to be observable.
  {
    id: 'contact-emails-dump',
    when: (q) => all(any('contact'), any('email', 'address'), any('all', 'export', 'list', 'every'))(q),
    build: () => 'SELECT CRM_Contacts.FULL_NAME, CRM_Contacts.EMAIL FROM CRM_Contacts',
  },
];

/**
 * Translate. `ctx` carries what the caller resolved from the org's own data:
 * `{ person, account, leadId, permission, leadSource, days }`.
 *
 * Returns { zcql, ruleId } or null.
 */
function translate(question, ctx = {}) {
  const q = String(question ?? '').toLowerCase().trim();
  if (!q) return null;

  const context = {
    ...ctx,
    leadId: ctx.leadId ?? leadIdIn(question),
    permission: ctx.permission ?? permissionTarget(question),
    days: ctx.days ?? daysIn(question),
  };

  for (const rule of RULES) {
    let hit = false;
    try { hit = rule.when(q, context); } catch { hit = false; }
    if (hit) return { zcql: rule.build(q, context), ruleId: rule.id };
  }
  return null;
}

/** Concrete suggestions, drawn from the loaded packs - never "please rephrase". */
function suggestionsFor(loaded) {
  const out = [];
  if (loaded.productKeys.includes('crm')) {
    out.push(
      "what's the source of lead <id>",
      'how many leads do we have',
      'break down leads by source',
      'which leads have no source set',
      'total pipeline value by stage'
    );
  }
  if (loaded.productKeys.includes('campaigns')) {
    out.push('can <user> create a segment in campaigns', 'list the segments');
  }
  if (loaded.productKeys.includes('desk')) {
    out.push('which departments is <user> in', 'how many open tickets per department');
  }
  out.push("who hasn't logged in for 30 days", 'which profiles can delete records');
  return out;
}

module.exports = {
  translate, RULES, mutationIntent, offTopic, suggestionsFor,
  leadIdIn, daysIn, daysAgo, expectedDepartment, permissionTarget,
};
