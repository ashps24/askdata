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

const time = require('./time');

const any = (...terms) => (q) => terms.some((t) => q.includes(t));
const all = (...preds) => (q) => preds.every((p) => p(q));

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

/* --------------------------------------------------- 1. mutation intent */

/**
 * Does this question ASK ASKDATA TO CHANGE SOMETHING?
 *
 * WHAT THIS IS NOT
 *
 * It is not what keeps the tool read-only. lib/guard.js is: it refuses any
 * non-SELECT verb unconditionally, logs it as a security event, and there is
 * no write path to disable. This check only decides WHICH MESSAGE the engineer
 * sees - "I only read data, here is the escalation" instead of whatever the
 * guard would have said.
 *
 * That asymmetry decides how it should be tuned, and the original got it
 * backwards. Firing wrongly tells an engineer with a perfectly good read
 * question that they asked to write - twice now, on "my user cannot create a
 * segment" and on "how many of them have lead create permission" - and sends
 * them back to the escalation queue the tool exists to empty. Failing to fire
 * costs nothing: the guard still refuses, just with different wording.
 *
 * So this is deliberately narrow. It fires only when the sentence is shaped
 * like a REQUEST, and never merely because a change verb appears - because in
 * this domain the change verbs are also the names of the permissions.
 * "Lead create permission" contains "create" and asks for nothing.
 */

/** Verbs that would change something, in their bare (imperative) forms. */
const CHANGE_VERB =
  'delete|remove|drop|purge|wipe|clear|set|change|update|edit|modify|fix|correct|' +
  'reset|revert|restore|add|create|assign|grant|revoke|enable|disable|deactivate|' +
  'activate|suspend|merge|rename|archive|convert|import|upload';

/** Nouns that make a sentence be ABOUT capability rather than asking for it. */
const CAPABILITY_NOUN =
  /\b(permission|permissions|privilege|privileges|entitlement|entitlements|access|rights)\b/;

/** Verbs that change WHO HAS a permission, as opposed to naming one. */
const GRANTING_VERB =
  /\b(grant|grants|granting|revoke|revokes|revoking|give|gives|giving|assign|assigns|assigning|enable|enables|enabling|disable|disables|disabling|add|adds|adding|remove|removes|removing|take away)\b/;

/**
 * A question, not an instruction. "How many of them have lead create
 * permission" opens with "how many" and is therefore asking something, whoever
 * else it mentions. The exception is a question addressed AT AskData - "can
 * you delete these" is interrogative in form and a request in substance - and
 * that is handled by REQUEST below, which is checked first.
 */
const INTERROGATIVE =
  /^\s*(?:so\s+|and\s+|also\s+|then\s+|ok\s+|okay\s+)*(how|who|whom|whose|which|what|when|where|why|is|are|was|were|do|does|did|has|have|had|could|should|will|would|any|are there|list|show|tell|give|find|count|display)\b/;

/**
 * Shapes that are genuinely requests. Each one addresses AskData or issues an
 * instruction; none of them fire on a sentence that merely names a permission.
 */
const REQUEST = [
  // "can you / can we / can I <change verb>"
  new RegExp(String.raw`\bcan\s+(you|we|i|u)\b[^.?!]*\b(${CHANGE_VERB})\b`),
  // "could you", "would you", "will you" + change verb
  new RegExp(String.raw`\b(could|would|will)\s+(you|we)\b[^.?!]*\b(${CHANGE_VERB})\b`),
  // "please <change verb>", anywhere
  new RegExp(String.raw`\b(please|pls|kindly)\b[^.?!]*\b(${CHANGE_VERB})\b`),
  // "I need you to <change verb>", "we want to <change verb>"
  new RegExp(String.raw`\b(i|we)\s+(need|want|would like)\b[^.?!]*\bto\s+(${CHANGE_VERB})\b`),
  // An imperative opener: the sentence STARTS with a change verb.
  new RegExp(String.raw`^\s*(?:just\s+|now\s+|quickly\s+)?(${CHANGE_VERB})\b`),
  // "set X to Y" / "change the source to Referral" - a verb with a target value.
  new RegExp(String.raw`\b(set|change|update|reset|revert|move|rename)\b[^.?!]*\b(to|back to)\s+\S`),
  // Explicitly bulk operations.
  /\b(bulk|mass)\s+(update|delete|import|edit|assign)\b/,
  // Granting a permission TO somebody is a change, however it is phrased.
  new RegExp(String.raw`\b(grant|revoke|take away)\b[^.?!]*` + CAPABILITY_NOUN.source),
];

function requestShape(q) {
  return REQUEST.some((re) => re.test(q));
}

/**
 * Is this asking ABOUT permissions rather than asking to change them?
 * A capability noun with no granting verb is a description, not an
 * instruction - which is the whole of "how many users have create permission".
 */
function aboutCapability(q) {
  return CAPABILITY_NOUN.test(q) && !GRANTING_VERB.test(q);
}

/**
 * Frames that describe an inability, or ask whether a third party is able to
 * do something. Both are pure reads that resolve to a permission lookup.
 */
const DIAGNOSTIC = [
  /\b(can'?t|cannot|can not|unable to|not able to|couldn'?t|isn'?t able|denied|no permission|not allowed|lacks?|doesn'?t have|does not have|missing the)\b/,
  /\bcan\s+(?!you\b|we\b|i\b|u\b|it\b)(?:[a-z0-9._@'-]+\s+){1,5}(create|delete|edit|update|modify|export|view|see|read|access|assign|grant)\b/,
  /\bdoes\s+(?:[a-z0-9._@'-]+\s+){1,4}have\b/,
  /\b(who|which|what)\s+(?:[a-z0-9._'-]+\s+){0,3}(can|cannot|has|have|is able|are able)\b/,
];

function diagnosticIntent(question) {
  const q = String(question ?? '').toLowerCase();
  return DIAGNOSTIC.some((re) => re.test(q));
}

function mutationIntent(question) {
  const q = String(question ?? '').toLowerCase().trim();
  if (!q) return false;

  // A request wins outright: "can you please delete these leads" is a request
  // whatever else is true of it.
  if (requestShape(q)) return true;

  // Everything below is a read. Each of these has been a real false positive.
  if (INTERROGATIVE.test(q)) return false;
  if (aboutCapability(q)) return false;
  if (diagnosticIntent(q)) return false;

  return false;
}

/* ------------------------------------------------------- 2. off topic */

/**
 * Words that mean the question is about the customer's data at all.
 *
 * These are STEMS, matched as substrings, because the test is "is this about
 * the data" and not "is this spelled canonically". `logg` covers logged,
 * logging and logged-in; `export` covers exports and exported. Getting this
 * wrong is expensive in one direction only: a false "off topic" tells a support
 * engineer their perfectly good question is nonsense, which is the fastest way
 * to lose them back to the escalation queue.
 */
const ON_TOPIC = [
  'lead', 'contact', 'account', 'deal', 'pipeline', 'export', 'source', 'user',
  'profile', 'permission', 'segment', 'list', 'campaign', 'department', 'ticket',
  'logg', 'login', 'log in', 'sign in', 'signed', 'signin', 'audit', 'activity',
  'licence', 'license', 'stage', 'field', 'histor', 'chang', 'member', 'agent',
  'employee', 'staff', 'record', 'org', 'admin', 'access', 'role', 'email',
  'phone', 'company', 'dormant', 'inactive', 'stale', 'idle', 'seat', 'people',
  'person', 'revenue', 'amount', 'value', 'owner', 'assign', 'creat', 'modif',
  'delet', 'denied', 'granted', 'open', 'closed', 'resolv', 'priorit', 'subscri',
];

/** Stop words never worth treating as a topic signal. */
const NOT_A_TOPIC = new Set([
  'id', 'ref', 'org', 'name', 'type', 'kind', 'status', 'count', 'date', 'time',
  'from', 'this', 'that', 'with', 'were', 'when', 'what', 'which', 'null',
]);

/**
 * The vocabulary a question can be about, grown from the packs that are
 * actually loaded. A new product pack teaches this check its own words without
 * anybody remembering to edit a list here - the same reason the guard reads its
 * allowlist from the packs rather than carrying its own copy.
 */
function vocabularyFor(loaded) {
  const words = new Set(ON_TOPIC);
  for (const table of loaded?.tables ?? []) {
    for (const part of String(table.label ?? '').toLowerCase().split(/[^a-z]+/)) {
      if (part.length > 3 && !NOT_A_TOPIC.has(part)) words.add(part);
    }
    for (const column of table.columnNames ?? []) {
      for (const part of column.toLowerCase().split(/[^a-z]+/)) {
        if (part.length > 3 && !NOT_A_TOPIC.has(part)) words.add(part);
      }
    }
  }
  for (const [key, alternatives] of Object.entries(loaded?.synonyms ?? {})) {
    words.add(key.toLowerCase());
    for (const alt of alternatives) words.add(String(alt).toLowerCase());
  }
  return [...words];
}

function offTopic(question, loaded = null) {
  const q = String(question ?? '').toLowerCase();
  return !vocabularyFor(loaded).some((w) => q.includes(w));
}

/* ---------------------------------------------------------- extraction */

/** A long numeric id, as customers quote them in tickets. */
function leadIdIn(question) {
  return /\b(\d{10,})\b/.exec(String(question ?? ''))?.[1] ?? null;
}

/**
 * How long a period the question is about, in days.
 *
 * People do not write "30 days". They write "the last one month", "a
 * fortnight", "this quarter". Only understanding "N days" meant the commonest
 * phrasing of a time-window question fell through to "I couldn't work that
 * out", which is a parser problem presented to the user as their mistake.
 */
const UNIT_DAYS = {
  day: 1, days: 1, week: 7, weeks: 7, fortnight: 14,
  month: 30, months: 30, quarter: 90, quarters: 90, year: 365, years: 365,
};

const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};

function daysIn(question, fallback = 30) {
  const text = String(question ?? '').toLowerCase();
  const m =
    /(?:\b(?:last|past|previous|recent|this)\s+)?\b(\d{1,4}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)?\s*(day|days|week|weeks|fortnight|month|months|quarter|quarters|year|years)\b/
      .exec(text);
  if (!m) return fallback;

  const unit = UNIT_DAYS[m[2]] ?? 1;
  const countToken = m[1];
  const count = countToken === undefined
    ? 1
    : (WORD_NUMBERS[countToken] ?? Number(countToken));
  return Math.max(1, Math.round((Number.isFinite(count) ? count : 1) * unit));
}

/**
 * A date literal `days` ago, in Data Store's datetime shape.
 *
 * Naive IST, not UTC. Data Store datetimes carry no offset and are read in the
 * project's timezone, so a toISOString() bound would be 5.5 hours adrift - the
 * same mistake that once made a 02:14 export read as 07:44.
 */
function daysAgo(days) {
  return time.daysAgoNaive(days);
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
  ['application', 'directory', 'Applications'], ['app', 'directory', 'Applications'],
  ['policy', 'directory', 'Policies'], ['group', 'directory', 'Groups'],
];
const ACTIONS = [
  ['create', 'create'], ['add', 'create'], ['make', 'create'], ['new', 'create'],
  ['delete', 'delete'], ['remove', 'delete'],
  ['edit', 'edit'], ['update', 'edit'], ['change', 'edit'], ['modify', 'edit'],
  ['export', 'export'], ['download', 'export'],
  ['share', 'share'], ['approve', 'approve'],
  ['view', 'view'], ['see', 'view'], ['read', 'view'], ['access', 'view'], ['open', 'view'],
];

/**
 * The permission a question is about, if it names one.
 *
 * Whole words, not substrings: "in the account can delete tickets" contains
 * "account", and substring matching read that as crm.accounts.delete and
 * refused a perfectly good Desk question as CRM's. And when a question names
 * modules from more than one service, the session's own service wins - the
 * engineer connected to Desk is asking about Desk.
 */
function permissionTarget(question, serviceKey = null) {
  const q = String(question ?? '').toLowerCase();
  const act = ACTIONS.find(([w]) => new RegExp(`\\b${w}(?:s|ed|ing)?\\b`).test(q));
  if (!act) return null;

  const hits = MODULES.filter(([w]) => new RegExp(`\\b${w}s?\\b`).test(q));
  if (!hits.length) return null;

  const scoped = serviceKey && serviceKey !== 'all' ? String(serviceKey) : null;
  const mod = (scoped && hits.find(([, product]) => product === scoped)) || hits[0];
  return { product: mod[1], module: mod[2], action: act[1], key: `${mod[1]}.${mod[2].toLowerCase()}.${act[1]}` };
}

/** The action alone - so "who can delete records" can be seen to name no module. */
function permissionAction(question) {
  const q = String(question ?? '').toLowerCase();
  const act = ACTIONS.find(([w]) => q.includes(w));
  return act ? act[1] : null;
}

/**
 * The modules a permission question could be about, within one service.
 *
 * "Which profiles can delete records" names an action and no module. In a
 * Desk session the honest options are tickets and departments - offering leads
 * there would be offering another service's data. With no service (a bare
 * ZGID session) every module of every subscribed product is fair game.
 */
function modulesFor(serviceKey, orgProducts = null) {
  const scoped = serviceKey && serviceKey !== 'all' ? String(serviceKey) : null;
  const owned = orgProducts ? new Set(orgProducts) : null;
  return MODULES
    .filter(([, product]) => (scoped ? product === scoped : true))
    .filter(([, product]) => (owned ? owned.has(product) : true))
    .map(([word, product, module]) => ({ word, product, module, plural: `${word}s` }));
}

/**
 * "my user", "the agent", "this employee" - a person meant but not named.
 *
 * Support questions arrive this way constantly, because the engineer is looking
 * at the customer's own words. It is not answerable and it is not refusable:
 * the honest response is to ask which user, which is rule 4 applied to a set of
 * candidates too large to list rather than to two people with the same name.
 */
const VAGUE_PERSON =
  /\b(my|the|this|that|a|an|their|his|her|its|our|customer'?s?|client'?s?)\s+(user|agent|employee|person|admin|rep|member|account holder)\b/;

/**
 * Plural and collective forms. "All the users" is a request about everybody,
 * not an unnamed individual, and asking "which user did you mean?" in reply is
 * both wrong and irritating - it was the first thing that broke when the
 * unnamed-person clarify went in.
 */
const COLLECTIVE_PEOPLE =
  /\b(all|every|each|list|which|who|any|both|several|many|most|the\s+full|a\s+list\s+of)\b[^.?!]{0,24}\b(users|agents|employees|people|persons|admins|reps|members|staff)\b|\b(users|agents|employees|people|admins|members|staff)\b/;

function vaguePersonReference(question) {
  const q = String(question ?? '').toLowerCase();
  if (COLLECTIVE_PEOPLE.test(q)) return false;
  return VAGUE_PERSON.test(q);
}

/**
 * A proper noun the question hangs a filter on: "how many contacts are at
 * Aurora Systems".
 *
 * This exists because of the worst answer this tool produced in testing. Asked
 * about contacts at an account that does not exist, it dropped the name and
 * replied "40 contacts" - the org-wide total, stated with complete confidence.
 * A refusal costs the engineer a minute; a confidently wrong number goes into a
 * ticket and out to a customer. So a name that resolves to nothing has to stop
 * the answer, not quietly widen it.
 *
 * Deliberately narrow: it only fires on a name in a filtering position after
 * at/for/of/in/from/called, and only for questions about CRM records, so that
 * data-valued capitals elsewhere ("open tickets in Billing") are left alone.
 */
const LOCATOR =
  /\b(?:at|for|of|in|from|called|named|belonging to)\s+("?[A-Z][\w&.'-]*(?:\s+(?:[A-Z][\w&.'-]*|of|and|the))*"?)/;

const RECORD_WORDS = /\b(contact|account|company|customer|deal|lead|opportunit)/i;

function namedEntity(question, loaded = null) {
  const text = String(question ?? '');
  // The words below are CRM's, and the lookup they lead to is CRM_Accounts. In
  // a session that has not loaded CRM there is nothing to resolve against and
  // no account name that may be shown.
  if (loaded && !loaded.tableNames?.includes('CRM_Accounts')) return null;
  if (!RECORD_WORDS.test(text)) return null;

  const phrase = LOCATOR.exec(text)?.[1]?.replace(/"/g, '').trim();
  if (!phrase || phrase.length < 3) return null;

  // A capital that is really a schema word or an enum value is not a name.
  const known = new Set(vocabularyFor(loaded));
  for (const table of loaded?.tables ?? []) {
    for (const column of table.columns ?? []) {
      for (const value of column.values ?? []) known.add(String(value).toLowerCase());
    }
    known.add(String(table.label ?? '').toLowerCase());
    known.add(table.name.toLowerCase());
  }
  const lower = phrase.toLowerCase();
  if (known.has(lower) || [...known].some((w) => w.length > 3 && lower === w)) return null;

  return phrase;
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
    about: 'access',
    when: (q, ctx) => Boolean(ctx.person) && Boolean(ctx.permission),
    build: (q, ctx) =>
      'SELECT Users.FULL_NAME, Profiles.PROFILE_NAME, Profiles.PRODUCT, ' +
      'Permissions.PERMISSION_KEY, ProfilePermissions.GRANTED ' + PERMISSION_CHAIN +
      `WHERE Users.USER_ID = ${lit(ctx.person.USER_ID)} ` +
      `AND Permissions.PERMISSION_KEY = ${lit(ctx.permission.key)}`,
  },
  {
    id: 'person-permissions-all',
    about: 'access',
    when: (q, ctx) => Boolean(ctx.person) && any('permission', 'privilege', 'access', 'can they', 'what can', 'allowed')(q),
    build: (q, ctx) =>
      'SELECT Profiles.PROFILE_NAME, Profiles.PRODUCT, Permissions.PERMISSION_KEY, ' +
      'ProfilePermissions.GRANTED ' + PERMISSION_CHAIN +
      `WHERE Users.USER_ID = ${lit(ctx.person.USER_ID)} AND ProfilePermissions.GRANTED = 'true' ` +
      'ORDER BY Permissions.PERMISSION_KEY',
  },
  {
    // Every user, with whether they hold one named permission - in ONE query.
    //
    // This is the shape support actually needs: not "can Priya create leads"
    // but "who can, and who can't". It is the full four-join spine with the
    // permission pinned and the user left open, so a single read returns both
    // sides of the answer. Every profile carries a row per permission with
    // GRANTED true or false, so nobody is missing from the result.
    id: 'users-by-permission',
    about: 'access',
    // No wh-word requirement. "users has permission to create leads" is the
    // same question as "which users can create leads", and demanding "which"
    // meant a typo in that one word - which the corrector rightly refuses to
    // guess at, since "wich" is equally close to "with" - lost the whole
    // question. A named permission plus a plural of people is enough.
    when: (q, ctx) =>
      Boolean(ctx.permission) && !ctx.person && CAPABILITY.test(q) &&
      PEOPLE_OR_PRONOUN.test(q),
    build: (q, ctx) =>
      // PERMISSION_KEY is selected so the answer can name the permission it
      // actually queried. Without it the shaper guessed the noun from the
      // question text and said "can delete accounts" about a query that asked
      // about tickets - right rows, wrong sentence.
      'SELECT Users.USER_ID, Users.FULL_NAME, Users.EMAIL, Profiles.PROFILE_NAME, ' +
      'Permissions.PERMISSION_KEY, ProfilePermissions.GRANTED ' +
      PERMISSION_CHAIN +
      `WHERE Permissions.PERMISSION_KEY = ${lit(ctx.permission.key)} ` +
      'ORDER BY Users.FULL_NAME',
  },
  {
    id: 'profiles-with-action',
    about: 'access',
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
    about: 'access',
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
    about: 'access',
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
    about: 'access',
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
    // The inverse of dormant-users. "Active" has to be matched as a whole word
    // that is not the tail of "inactive", or every dormancy question would be
    // answered with its own opposite.
    id: 'active-users',
    about: 'access',
    when: (q) =>
      /(?<!in)\bactive\b|\blogged in\b|\bsigned in\b|\bhave logged\b/.test(q) &&
      !/\binactive\b|\bdormant\b|\bhasn'?t\b|\bhaven'?t\b|\bhas not\b|\bhave not\b|\bnever\b|\bnot logged\b/.test(q) &&
      /\buser|people|agent|employee|staff|who\b/.test(q),
    build: (q, ctx) =>
      'SELECT Users.FULL_NAME, Users.EMAIL, Users.STATUS, Users.LAST_LOGIN FROM Users ' +
      `WHERE Users.LAST_LOGIN >= ${lit(daysAgo(ctx.days))} ` +
      'ORDER BY Users.LAST_LOGIN DESC',
  },
  {
    id: 'dormant-users',
    about: 'access',
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
    about: 'access',
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

  /* -- configuration: what the admin has set up ------------------------- */
  //
  // The "before I reply, I want to know" questions. Each is a small
  // configuration table read whole for one org; the guard permits it because
  // the tables are declared listable.
  {
    id: 'desk-email-auth',
    when: (q) => any('dmarc', 'dkim', 'spf', 'email authentication', 'domain authentication', 'sender authentication', 'email auth')(q)
      && !any('campaign', 'sending domain', 'mailer', 'newsletter')(q),
    build: () =>
      'SELECT DESK_EmailConfig.SUPPORT_EMAIL, DESK_EmailConfig.SENDING_DOMAIN, DESK_EmailConfig.SPF_STATUS, ' +
      'DESK_EmailConfig.DKIM_STATUS, DESK_EmailConfig.DMARC_STATUS, DESK_EmailConfig.DMARC_POLICY, ' +
      'DESK_EmailConfig.LAST_VERIFIED_ON FROM DESK_EmailConfig ORDER BY DESK_EmailConfig.SUPPORT_EMAIL',
  },
  {
    id: 'campaigns-sender-auth',
    when: (q) => any('sending domain', 'sender domain', 'dedicated ip')(q)
      || (any('dmarc', 'dkim', 'spf', 'authenticat')(q) && any('campaign', 'mailer', 'newsletter', 'sending')(q)),
    build: () =>
      'SELECT CMP_SenderDomains.DOMAIN_NAME, CMP_SenderDomains.SPF_STATUS, CMP_SenderDomains.DKIM_STATUS, ' +
      'CMP_SenderDomains.DMARC_STATUS, CMP_SenderDomains.DEDICATED_IP, CMP_SenderDomains.VERIFIED_ON ' +
      'FROM CMP_SenderDomains ORDER BY CMP_SenderDomains.IS_DEFAULT DESC',
  },
  {
    id: 'desk-assignment-rules',
    when: (q) => any('round robin', 'round-robin', 'skill based', 'skill-based', 'assignment rule', 'auto assign', 'auto-assign', 'ticket routing', 'load balanc')(q)
      && !any('lead', 'deal', 'crm')(q),
    build: () =>
      'SELECT DESK_AssignmentRules.RULE_NAME, DESK_AssignmentRules.RULE_TYPE, DESK_AssignmentRules.STATUS, ' +
      'DESK_Departments.DEPARTMENT_NAME, DESK_AssignmentRules.AGENT_COUNT, DESK_AssignmentRules.SKILLS, ' +
      'DESK_AssignmentRules.TICKETS_ASSIGNED_30D FROM DESK_AssignmentRules ' +
      'LEFT JOIN DESK_Departments ON DESK_AssignmentRules.DEPARTMENT_REF = DESK_Departments.ROWID ' +
      'ORDER BY DESK_AssignmentRules.RULE_TYPE',
  },
  {
    id: 'crm-assignment-rules',
    when: (q) => any('assignment rule', 'round robin', 'round-robin', 'auto assign', 'lead routing', 'lead distribution')(q)
      && any('lead', 'deal', 'crm', 'record')(q),
    build: () =>
      'SELECT CRM_AssignmentRules.RULE_NAME, CRM_AssignmentRules.MODULE, CRM_AssignmentRules.ROUND_ROBIN, ' +
      'CRM_AssignmentRules.ASSIGN_TO, CRM_AssignmentRules.CRITERIA, CRM_AssignmentRules.STATUS, ' +
      'CRM_AssignmentRules.RECORDS_ASSIGNED_30D FROM CRM_AssignmentRules ORDER BY CRM_AssignmentRules.MODULE',
  },
  {
    id: 'desk-help-center',
    when: (q) => any('portal', 'help center', 'help centre', 'helpcenter', 'knowledge base', 'self service', 'self-service', 'asap widget', 'community')(q),
    build: () =>
      'SELECT DESK_HelpCenters.HELP_CENTER_NAME, DESK_HelpCenters.STATUS, DESK_HelpCenters.ACCESS, ' +
      'DESK_HelpCenters.PORTAL_URL, DESK_HelpCenters.KB_ARTICLES, DESK_HelpCenters.COMMUNITY_ENABLED, ' +
      'DESK_HelpCenters.ASAP_ENABLED, DESK_HelpCenters.LAUNCHED_ON FROM DESK_HelpCenters',
  },
  {
    id: 'desk-guided-conversations',
    when: (q) => any('guided conversation', 'gc flow', 'chat flow', 'bot flow', 'decision tree', 'guided conv')(q),
    build: () =>
      'SELECT DESK_GuidedConversations.FLOW_NAME, DESK_GuidedConversations.STATUS, DESK_GuidedConversations.CHANNEL, ' +
      'DESK_Departments.DEPARTMENT_NAME, DESK_GuidedConversations.BLOCK_COUNT, DESK_GuidedConversations.SESSIONS_30D, ' +
      'DESK_GuidedConversations.MODIFIED_ON FROM DESK_GuidedConversations ' +
      'LEFT JOIN DESK_Departments ON DESK_GuidedConversations.DEPARTMENT_REF = DESK_Departments.ROWID ' +
      'ORDER BY DESK_GuidedConversations.SESSIONS_30D DESC',
  },
  {
    id: 'desk-custom-functions',
    when: (q) => any('custom function', 'deluge', 'function')(q) && !any('permission', 'can ', 'profile')(q),
    build: (q) =>
      'SELECT DESK_CustomFunctions.FUNCTION_NAME, DESK_CustomFunctions.TRIGGER_TYPE, DESK_CustomFunctions.LINKED_TO, ' +
      'DESK_CustomFunctions.STATUS, DESK_CustomFunctions.EXECUTIONS_30D, DESK_CustomFunctions.FAILURES_30D, ' +
      'DESK_CustomFunctions.LAST_ERROR, DESK_CustomFunctions.LAST_RUN_ON FROM DESK_CustomFunctions ' +
      (any('fail', 'error', 'broken', 'not working')(q) ? "WHERE DESK_CustomFunctions.STATUS = 'error' " : '') +
      'ORDER BY DESK_CustomFunctions.FAILURES_30D DESC',
  },
  {
    id: 'desk-business-hours',
    when: (q) => any('business hours', 'working hours', 'operating hours', 'holiday', 'support hours')(q),
    build: () =>
      'SELECT DESK_BusinessHours.SCHEDULE_NAME, DESK_BusinessHours.TIMEZONE, DESK_BusinessHours.WORKING_DAYS, ' +
      'DESK_BusinessHours.START_TIME, DESK_BusinessHours.END_TIME, DESK_BusinessHours.HOLIDAYS_COUNT, ' +
      'DESK_BusinessHours.IS_DEFAULT, DESK_BusinessHours.USED_BY_SLA FROM DESK_BusinessHours ORDER BY DESK_BusinessHours.IS_DEFAULT DESC',
  },
  {
    id: 'desk-security-settings',
    when: (q) => any('ip restriction', 'ip range', 'csp', 'field encryption', 'idle timeout', 'attachment control', 'security setting')(q)
      && !any('directory', 'mfa', 'password policy')(q),
    build: () =>
      'SELECT DESK_SecuritySettings.SETTING_NAME, DESK_SecuritySettings.STATUS, DESK_SecuritySettings.SETTING_VALUE, ' +
      'DESK_SecuritySettings.MODIFIED_ON FROM DESK_SecuritySettings ORDER BY DESK_SecuritySettings.SETTING_NAME',
  },
  {
    id: 'desk-zia',
    when: (q) => any('zia', 'sentiment', 'answer bot', 'auto tag', 'field prediction', 'ai feature', 'reply assistant')(q),
    build: () =>
      'SELECT DESK_ZiaSettings.FEATURE, DESK_ZiaSettings.STATUS, DESK_ZiaSettings.AI_PROVIDER, ' +
      'DESK_ZiaSettings.DEPARTMENTS_COVERED, DESK_ZiaSettings.ENABLED_ON FROM DESK_ZiaSettings ORDER BY DESK_ZiaSettings.FEATURE',
  },
  {
    id: 'workflow-rules',
    when: (q) => any('workflow')(q) && !any('journey', 'campaign')(q),
    build: (q, ctx) => {
      const desk = ctx.loaded?.tableNames?.includes('DESK_WorkflowRules');
      const crm = ctx.loaded?.tableNames?.includes('CRM_WorkflowRules');
      const useDesk = desk && (!crm || any('ticket', 'desk', 'department')(q));
      return useDesk
        ? 'SELECT DESK_WorkflowRules.WORKFLOW_NAME, DESK_WorkflowRules.TRIGGER_ON, DESK_WorkflowRules.STATUS, ' +
          'DESK_WorkflowRules.ACTION_TYPES, DESK_WorkflowRules.EXECUTIONS_30D, DESK_WorkflowRules.LAST_RUN_ON ' +
          'FROM DESK_WorkflowRules ORDER BY DESK_WorkflowRules.EXECUTIONS_30D DESC'
        : 'SELECT CRM_WorkflowRules.WORKFLOW_NAME, CRM_WorkflowRules.MODULE, CRM_WorkflowRules.TRIGGER_ON, ' +
          'CRM_WorkflowRules.STATUS, CRM_WorkflowRules.ACTION_TYPES, CRM_WorkflowRules.EXECUTIONS_30D, ' +
          'CRM_WorkflowRules.LAST_RUN_ON FROM CRM_WorkflowRules ORDER BY CRM_WorkflowRules.EXECUTIONS_30D DESC';
    },
  },
  {
    id: 'crm-duplicate-rules',
    when: (q) => any('duplicate', 'dedupe', 'dedup', 'find and merge')(q) && !any('created', 'when were')(q),
    build: () =>
      'SELECT CRM_DuplicateRules.MODULE, CRM_DuplicateRules.MATCH_FIELDS, CRM_DuplicateRules.ACTION_ON_DUPLICATE, ' +
      'CRM_DuplicateRules.STATUS, CRM_DuplicateRules.DUPLICATES_FOUND_LAST_RUN, CRM_DuplicateRules.LAST_RUN_ON ' +
      'FROM CRM_DuplicateRules ORDER BY CRM_DuplicateRules.MODULE',
  },
  {
    id: 'crm-blueprints',
    when: (q) => any('blueprint', 'sales process', 'stage transition')(q),
    build: () =>
      'SELECT CRM_Blueprints.BLUEPRINT_NAME, CRM_Blueprints.MODULE, CRM_Blueprints.STATUS, CRM_Blueprints.STATES, ' +
      'CRM_Blueprints.TRANSITIONS, CRM_Blueprints.RECORDS_IN_PROCESS, CRM_Blueprints.MODIFIED_ON FROM CRM_Blueprints',
  },
  {
    id: 'crm-sharing-rules',
    when: (q) => any('sharing rule', 'data sharing', 'record sharing', 'sharing setting')(q),
    build: () =>
      'SELECT CRM_SharingRules.RULE_NAME, CRM_SharingRules.MODULE, CRM_SharingRules.SHARE_FROM, CRM_SharingRules.SHARE_TO, ' +
      'CRM_SharingRules.ACCESS_LEVEL, CRM_SharingRules.STATUS FROM CRM_SharingRules ORDER BY CRM_SharingRules.MODULE',
  },
  {
    id: 'campaigns-journeys',
    when: (q) => any('journey', 'automation', 'autoresponder', 'drip', 'automated series', 'automated workflow')(q) && !any('desk', 'ticket', 'crm rule')(q),
    build: (q) =>
      'SELECT CMP_Journeys.JOURNEY_NAME, CMP_Journeys.STATUS, CMP_Journeys.TRIGGER_TYPE, CMP_Lists.LIST_NAME, ' +
      'CMP_Journeys.STEPS, CMP_Journeys.CONTACTS_IN_JOURNEY, CMP_Journeys.MODIFIED_ON FROM CMP_Journeys ' +
      'LEFT JOIN CMP_Lists ON CMP_Journeys.LIST_REF = CMP_Lists.ROWID ' +
      (any('active', 'running', 'live')(q) ? "WHERE CMP_Journeys.STATUS = 'active' " : '') +
      'ORDER BY CMP_Journeys.CONTACTS_IN_JOURNEY DESC',
  },
  {
    id: 'campaigns-signup-forms',
    when: (q) => any('signup form', 'sign up form', 'sign-up form', 'popup form', 'pop-up form', 'subscribe form', 'embedded form', 'forms')(q),
    build: () =>
      'SELECT CMP_SignupForms.FORM_NAME, CMP_SignupForms.FORM_TYPE, CMP_Lists.LIST_NAME, CMP_SignupForms.STATUS, ' +
      'CMP_SignupForms.DOUBLE_OPT_IN, CMP_SignupForms.SUBMISSIONS_30D FROM CMP_SignupForms ' +
      'LEFT JOIN CMP_Lists ON CMP_SignupForms.LIST_REF = CMP_Lists.ROWID ORDER BY CMP_SignupForms.SUBMISSIONS_30D DESC',
  },
  {
    id: 'campaigns-ab-tests',
    when: (q) => any('a/b test', 'ab test', 'a b test', 'split test', 'subject line test')(q),
    build: () =>
      'SELECT CMP_Campaigns.CAMPAIGN_NAME, CMP_AbTests.TEST_TYPE, CMP_AbTests.VARIANT_A_OPEN_RATE, ' +
      'CMP_AbTests.VARIANT_B_OPEN_RATE, CMP_AbTests.WINNER, CMP_AbTests.SAMPLE_SIZE, CMP_AbTests.COMPLETED_ON ' +
      'FROM CMP_AbTests INNER JOIN CMP_Campaigns ON CMP_AbTests.CAMPAIGN_REF = CMP_Campaigns.ROWID ' +
      'ORDER BY CMP_AbTests.COMPLETED_ON DESC',
  },
  {
    id: 'campaigns-topics',
    when: (q) => any('topic', 'frequency cap', 'subscription preference')(q),
    build: () =>
      'SELECT CMP_Topics.TOPIC_NAME, CMP_Topics.SUBSCRIBERS, CMP_Topics.FREQUENCY_CAP_PER_WEEK, CMP_Topics.STATUS ' +
      'FROM CMP_Topics ORDER BY CMP_Topics.SUBSCRIBERS DESC',
  },

  /* -- directory ---------------------------------------------------------- */
  {
    id: 'directory-security-policies',
    about: 'access',
    when: (q) => any('security polic', 'password policy', 'mfa', 'multi factor', 'multi-factor', 'two factor', '2fa', 'session policy', 'ip restriction')(q)
      && !any('desk', 'ticket')(q),
    build: () =>
      'SELECT DIR_SecurityPolicies.POLICY_NAME, DIR_SecurityPolicies.POLICY_TYPE, DIR_SecurityPolicies.STATUS, ' +
      'DIR_SecurityPolicies.APPLIES_TO, DIR_SecurityPolicies.SETTINGS, DIR_SecurityPolicies.MODIFIED_ON ' +
      'FROM DIR_SecurityPolicies ORDER BY DIR_SecurityPolicies.POLICY_TYPE',
  },
  {
    id: 'directory-tenant',
    when: (q) => any('tenant', 'connected to', 'directory store', 'synced from', 'sync source', 'active directory', 'azure ad', 'verified domain')(q),
    build: () =>
      'SELECT DIR_Domains.DOMAIN_NAME, DIR_Domains.VERIFICATION_STATUS, DIR_Domains.TENANT_NAME, DIR_Domains.TENANT_ID, ' +
      'DIR_Domains.SYNC_SOURCE, DIR_Domains.IS_PRIMARY FROM DIR_Domains ORDER BY DIR_Domains.IS_PRIMARY DESC',
  },
  {
    id: 'directory-user-apps',
    about: 'access',
    when: (q, ctx) => Boolean(ctx.person) && any('app', 'application', 'part of', 'access to', 'assigned to')(q),
    build: (q, ctx) =>
      'SELECT DIR_Applications.APP_NAME, DIR_Applications.APP_TYPE, DIR_UserApplications.ROLE_IN_APP, ' +
      'DIR_UserApplications.STATUS, DIR_UserApplications.LAST_ACCESSED FROM DIR_UserApplications ' +
      'INNER JOIN DIR_Applications ON DIR_UserApplications.APP_REF = DIR_Applications.ROWID ' +
      `WHERE DIR_UserApplications.USER_ID = ${lit(ctx.person.USER_ID)} ORDER BY DIR_UserApplications.LAST_ACCESSED DESC`,
  },
  {
    id: 'directory-applications',
    when: (q) => any('application', 'apps', 'sso', 'single sign', 'provisioning', 'scim')(q),
    build: () =>
      'SELECT DIR_Applications.APP_NAME, DIR_Applications.APP_TYPE, DIR_Applications.SSO_ENABLED, ' +
      'DIR_Applications.PROVISIONING, DIR_Applications.ASSIGNED_USERS, DIR_Applications.STATUS ' +
      'FROM DIR_Applications ORDER BY DIR_Applications.ASSIGNED_USERS DESC',
  },
  {
    id: 'directory-groups',
    when: (q) => any('directory group', 'collaboration group', 'groups in directory', 'org chart')(q)
      || (any('group')(q) && !any('by ', 'permission', 'department')(q)),
    build: () =>
      'SELECT DIR_Groups.GROUP_NAME, DIR_Groups.GROUP_TYPE, DIR_Groups.MEMBER_COUNT, Users.FULL_NAME, DIR_Groups.CREATED_ON ' +
      'FROM DIR_Groups LEFT JOIN Users ON DIR_Groups.OWNER_REF = Users.ROWID ORDER BY DIR_Groups.GROUP_TYPE',
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
/**
 * Capability language: what separates "who CAN export contacts" from "who
 * exported contacts". Both name people and an action, and both produce a
 * permission target - "changed the lead source" reads as crm.leads.edit - but
 * only the first is a permission question. The second is history and must
 * still reach the history rules.
 */
const CAPABILITY =
  /\b(can|cannot|can'?t|could|may|able|unable|allowed|permitted|permission|permissions|privilege|privileges|entitled|rights|authorised|authorized)\b/;

/**
 * Words that mean people - including the bare plural pronouns.
 *
 * "How many of THEM have lead create permission" is a follow-up, and them is
 * the only thing naming the subject. A pronoun is ambiguous on its own - after
 * a question about leads it could mean leads - but this pattern is only ever
 * consulted together with a resolved permission and capability language, and
 * permissions attach to users and profiles, never to records. That pairing is
 * what makes admitting the pronoun safe.
 *
 * The answer states its own scope for the same reason: it reports "15 of 25
 * users", not "15 of them", so an engineer can see it was computed over the
 * whole account rather than over whatever the previous question returned.
 */
const PEOPLE_OR_PRONOUN =
  /\b(user|users|people|person|persons|agent|agents|employee|employees|staff|profile|profiles|role|roles|everyone|anyone|anybody|who|whom|them|they|these|those)\b/;

/**
 * Is this about who may do something, rather than about the things themselves?
 *
 * "How many users can create leads" names leads, and every keyword a lead-
 * counting rule looks for is present - "how many", "leads". But leads are the
 * OBJECT of the permission here, not the thing being counted, and answering
 * "40 leads" is not a near miss; it is a confident answer to a question nobody
 * asked, which is the worst thing this tool can do.
 *
 * Rule order alone fixed the one case and would break again the next time a
 * records rule was added above an access rule. So the question is classified
 * first, and a permission question is only ever offered the access rules.
 */
function accessQuestion(q, context) {
  if (!CAPABILITY.test(q)) return false;

  // A permission target, a permission noun, OR a bare action. "Which profiles
  // can delete records" names no module and never says "permission", but
  // "can delete" is a capability question about an action - and it must be
  // classified as one, or the clarify that asks "delete what?" never runs and
  // the question falls through to a rule that answers across every module.
  if (!context.permission && !permissionAction(q) &&
      !/\b(permission|permissions|privilege|privileges|access|rights)\b/.test(q)) {
    return false;
  }
  return PEOPLE_OR_PRONOUN.test(q);
}

function translate(question, ctx = {}) {
  const q = String(question ?? '').toLowerCase().trim();
  if (!q) return null;

  const context = {
    ...ctx,
    leadId: ctx.leadId ?? leadIdIn(question),
    permission: ctx.permission ?? permissionTarget(question, ctx.loaded?.serviceKey ?? null),
    days: ctx.days ?? daysIn(question),
  };

  // Access questions see only the access rules. Everything else sees all of
  // them, so nothing else changes behaviour.
  const candidates = accessQuestion(q, context)
    ? RULES.filter((r) => r.about === 'access')
    : RULES;

  for (const rule of candidates) {
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
      'total pipeline value by stage',
      'which users can create leads'
    );
  }
  if (loaded.productKeys.includes('crm')) {
    out.push('is there a duplicate rule on leads', 'which workflow rules are active');
  }
  if (loaded.productKeys.includes('campaigns')) {
    out.push(
      'can <user> create a segment in campaigns', 'list the segments',
      'is the sending domain authenticated', 'which journeys are active'
    );
  }
  if (loaded.productKeys.includes('desk')) {
    out.push(
      'has dmarc been configured',
      'is there a round robin assignment rule set up',
      'is the customer portal in use',
      'which guided conversation flows are published',
      'are any custom functions failing',
      'which departments is <user> in', 'how many open tickets per department'
    );
  }
  if (loaded.productKeys.includes('directory')) {
    out.push(
      'have security policies been configured',
      'which tenant is this org connected to',
      'is <user> part of any apps',
      'which apps have sso enabled'
    );
  }
  out.push(
    'which users have been active in the last one month',
    "who hasn't logged in for 30 days",
    'which profiles can delete records'
  );
  return out;
}

module.exports = {
  translate, RULES, mutationIntent, diagnosticIntent, offTopic, vocabularyFor, suggestionsFor,
  accessQuestion,
  namedEntity,
  vaguePersonReference,
  leadIdIn, daysIn, daysAgo, expectedDepartment, permissionTarget, permissionAction, modulesFor,
};
