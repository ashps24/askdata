'use strict';

/**
 * Turning rows into something a support engineer can send.
 *
 * Their job is not "see a result grid" - it is reply to the customer. So every
 * answer carries three things, and the third is the one that earns adoption:
 *
 *   summary        one plain sentence, for the engineer
 *   rows/columns   the grid, masked, with per-row Reveal
 *   ticket_comment a paste-ready reply written FOR THE CUSTOMER
 *
 * The ticket comment has rules the summary does not. No table names, no field
 * names in schema casing, no ZCQL, no replica jargon, no internal ids beyond
 * the one the customer themselves supplied. It ends with an "as of" so the
 * customer knows how fresh the answer is.
 *
 * EVERYTHING HERE IS COMPUTED, NOT GENERATED. No second model call. Two
 * reasons. Latency: the translate call already spends part of a 30-second
 * budget. And correctness: a model asked to summarise rows will occasionally
 * assert something the rows contradict, and a confidently wrong sentence pasted
 * into a customer's ticket is the worst output this tool could produce.
 *
 * SHAPERS. A registry, tried in order, first match wins, with a generic one at
 * the end that always works. A shaper exists per escalation pattern rather than
 * per table, because "did this person export data" and "list the exports" want
 * very different sentences from the same rows.
 */

const time = require('./time');
const rules = require('./rules');

/* ------------------------------------------------------------- formatting */

// Never convert: stored datetimes are already IST wall-clock. Converting would
// move the 02:14 export to 07:44 and report the wrong fact. See lib/time.js.
const fmtDate = (v) => time.formatDate(v);
const fmtDateTime = (v) => time.formatDateTime(v);

function fmtNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Avoid "Divya R.." - a masked surname already ends in a period. */
function sentence(text) {
  return String(text).replace(/\.\.(\s|$)/g, '.$1').replace(/\.\s*\./g, '.');
}

/**
 * The time window a question asked about, phrased as they phrased it.
 * Falls back to the resolved day count when they wrote nothing recognisable.
 */
function describeWindow(question) {
  const m =
    /\b(?:last|past|previous|recent|this)\s+((?:\d{1,4}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)?\s*(?:day|days|week|weeks|fortnight|month|months|quarter|quarters|year|years))\b/i
      .exec(String(question ?? ''));
  if (m) return `the last ${m[1].trim().replace(/\s+/g, ' ')}`;

  const bare = /\b(\d{1,4})\s*(day|days|week|weeks|month|months|year|years)\b/i.exec(String(question ?? ''));
  if (bare) return `the last ${bare[1]} ${bare[2].toLowerCase()}`;

  return `the last ${rules.daysIn(question)} days`;
}

function list(items, joiner = 'and') {
  const a = items.filter(Boolean).map(String);
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} ${joiner} ${a[a.length - 1]}`;
}

/** The aggregate key ZCQL actually returns - it discards the alias. */
function agg(row, fn, col) {
  const wanted = `${fn}(${col})`.toUpperCase();
  for (const [k, v] of Object.entries(row)) {
    if (k.toUpperCase().replace(/\s+/g, '') === wanted.replace(/\s+/g, '')) return v;
  }
  return undefined;
}

function firstAggregate(row) {
  for (const [k, v] of Object.entries(row)) {
    if (/^(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(k)) return { key: k, value: v };
  }
  return null;
}

/* ------------------------------------------------------------------ shapers */

/**
 * Each shaper: { id, match(ctx), build(ctx) -> { summary, ticket_comment, highlights? } }
 *
 * `ctx` = { question, rows, columns, tables, loaded, replica, grant, single }
 */
const SHAPERS = [
  /* ---- 0a. every user, against one permission ------------------------- */
  {
    /**
     * "Show me all the users and who can create leads."
     *
     * The result carries both halves of the answer - a GRANTED row per user -
     * so the summary must give the split and name the profiles responsible.
     * Reporting "15 granted, 10 denied across 25 rows" describes the result
     * set rather than answering the question; an engineer needs to know which
     * profile to change.
     */
    id: 'users-by-permission',
    match: ({ ruleId }) => ruleId === 'users-by-permission',
    build: ({ rows, question }) => {
      // Both halves of the sentence come from the permission the query ran on,
      // never from the question's wording - a question naming two modules
      // ("in the account ... delete tickets") would otherwise be answered in
      // the wrong noun.
      const key = rows[0]?.PERMISSION_KEY ?? null;
      const [, keyModule, keyAction] = key ? key.split('.') : [];
      const action = keyAction
        ?? /\b(create|delete|edit|update|export|view|share|approve)\b/i.exec(question)?.[1] ?? 'use';
      const what = keyModule
        ?? `${/\b(lead|contact|account|deal|ticket|segment|list|campaign)s?\b/i.exec(question)?.[1] ?? 'record'}s`;

      const yes = rows.filter((r) => r.GRANTED === true || r.GRANTED === 'true' || r.GRANTED === 'True');
      const no = rows.filter((r) => !(r.GRANTED === true || r.GRANTED === 'true' || r.GRANTED === 'True'));
      const profiles = (subset) => [...new Set(subset.map((r) => r.PROFILE_NAME).filter(Boolean))];
      const grantedProfiles = profiles(yes);
      const deniedProfiles = profiles(no);

      if (!rows.length) {
        return {
          summary: `No user profile in this account carries that permission.`,
          ticket_comment:
            'Hi, I checked this at our end. No profile in the account has that permission ' +
            'switched on, so no user currently has it.',
        };
      }

      return {
        summary: sentence(
          `${fmtNumber(yes.length)} of ${fmtNumber(rows.length)} users can ${action} ${what}` +
          (grantedProfiles.length ? ` (${list(grantedProfiles)})` : '') +
          (no.length
            ? `; the other ${fmtNumber(no.length)} cannot${deniedProfiles.length ? ` (${list(deniedProfiles)})` : ''}`
            : '')
        ),
        ticket_comment: sentence(
          `Hi, I checked this at our end. ${fmtNumber(yes.length)} of the ${fmtNumber(rows.length)} ` +
          `users in the account can ${action} ${what}, through the ` +
          `${list(grantedProfiles)} ${grantedProfiles.length === 1 ? 'profile' : 'profiles'}` +
          (no.length
            ? `. The remaining ${fmtNumber(no.length)} are on ${list(deniedProfiles)}, where that ` +
              'permission is switched off. An administrator can enable it on the profile, or move ' +
              'the user to a profile that already has it'
            : '')
        ),
        // Flag the denials: "who cannot" is the half that generates tickets.
        highlights: no.slice(0, 3).map((r) => ({
          row: rows.indexOf(r),
          why: `denied via ${r.PROFILE_NAME}`,
        })),
      };
    },
  },

  /* ---- 0b. users active within a window ------------------------------- */
  {
    id: 'active-users',
    match: ({ ruleId }) => ruleId === 'active-users',
    build: ({ rows, question }) => {
      // Say the window back in the user's own units. They asked about "the
      // last one month"; answering "the last 30 days" is correct but reads as
      // though the question was not understood.
      const window = describeWindow(question);
      if (!rows.length) {
        return {
          summary: `No user has signed in during ${window}.`,
          ticket_comment:
            `Hi, I checked this at our end. No user in the account has signed in during ${window}.`,
        };
      }
      const newest = rows[0]?.LAST_LOGIN;
      return {
        summary: sentence(
          `${fmtNumber(rows.length)} ${rows.length === 1 ? 'user has' : 'users have'} signed in during ` +
          `${window}${newest ? `, most recently on ${fmtDateTime(newest)}` : ''}`
        ),
        ticket_comment: sentence(
          `Hi, I checked this at our end. ${fmtNumber(rows.length)} ` +
          `${rows.length === 1 ? 'user has' : 'users have'} signed in during ${window}` +
          `${newest ? `, the most recent on ${fmtDateTime(newest)}` : ''}`
        ),
      };
    },
  },

  /* ---- 1. lead source for one lead ------------------------------------ */
  {
    id: 'lead-source',
    match: ({ tables, columns }) =>
      tables.includes('CRM_Leads') && columns.includes('LEAD_SOURCE'),
    build: ({ rows, question }) => {
      if (rows.length === 1) {
        const r = rows[0];
        const src = r.LEAD_SOURCE;
        const id = r.LEAD_ID ?? '';
        const created = fmtDate(r.CREATED_ON);
        const modified = r.MODIFIED_ON ? fmtDateTime(r.MODIFIED_ON) : null;
        const unchanged = r.CREATED_ON && r.MODIFIED_ON &&
          String(r.CREATED_ON).slice(0, 10) === String(r.MODIFIED_ON).slice(0, 10);

        if (src === null || src === undefined || src === '') {
          return {
            summary: `Lead ${id} has no source set. It was created on ${created}.`,
            ticket_comment:
              `Hi, I checked this at our end. The lead (ID ${id}) was created on ${created}, ` +
              `and no source has ever been recorded against it - the field is empty rather than ` +
              `showing an incorrect value. If it came in through a specific channel, we can look ` +
              `at how it was created to work out why the source was not captured.`,
            highlights: [{ row: 0, why: 'source is empty' }],
          };
        }

        return {
          summary:
            `Lead ${id} has source "${src}"${created ? `, on a record created ${created}` : ''}` +
            `${unchanged ? ' and unchanged since' : modified ? `, last modified ${modified}` : ''}.`,
          ticket_comment:
            `Hi, I checked this at our end. The lead (ID ${id}) was created on ${created} ` +
            `with the source recorded as "${src}". ` +
            (unchanged
              ? 'There has been no change to the source field since creation.'
              : `The record was last modified on ${modified}.`),
        };
      }

      // A breakdown: LEAD_SOURCE plus a count.
      const a = rows.length && firstAggregate(rows[0]);
      if (a) {
        const total = rows.reduce((s, r) => s + Number(r[a.key] ?? 0), 0);
        const parts = rows.map((r) => `${r.LEAD_SOURCE ?? 'no source set'} ${fmtNumber(r[a.key])}`);
        return {
          summary: `${list(parts)} — ${fmtNumber(total)} leads in total.`,
          ticket_comment:
            `Hi, I checked this at our end. Across the ${fmtNumber(total)} leads in the account, ` +
            `the sources break down as: ${rows.map((r) => `${r.LEAD_SOURCE ?? 'not set'} (${fmtNumber(r[a.key])})`).join(', ')}.`,
        };
      }

      // A list of leads, e.g. the ones with no source.
      const blank = /no source|blank|empty|without a source|not set/i.test(question);
      return {
        summary: blank
          ? `${fmtNumber(rows.length)} lead${rows.length === 1 ? '' : 's'} have no source set.`
          : `${fmtNumber(rows.length)} lead${rows.length === 1 ? '' : 's'} matched.`,
        ticket_comment: blank
          ? `Hi, I checked this at our end. There ${rows.length === 1 ? 'is' : 'are'} ` +
            `${fmtNumber(rows.length)} lead${rows.length === 1 ? '' : 's'} in the account with no ` +
            `source recorded. These are usually records created by import or through the API, ` +
            `where the source field was not supplied.`
          : `Hi, I checked this at our end. I found ${fmtNumber(rows.length)} matching ` +
            `lead${rows.length === 1 ? '' : 's'} in the account.`,
      };
    },
  },

  /* ---- 2. export history for one person ------------------------------- */
  {
    id: 'export-jobs',
    match: ({ tables }) => tables.includes('CRM_ExportJobs'),
    build: ({ rows, columns }) => {
      if (!rows.length) {
        return {
          summary: 'No CRM exports at all for that user.',
          ticket_comment:
            'Hi, I checked this at our end. There is no record of this user exporting any data ' +
            'from CRM. Export activity is logged, so an absence here means no export was run.',
        };
      }

      const a = firstAggregate(rows[0]);
      if (a && rows.length === 1) {
        return {
          summary: `${fmtNumber(rows[0][a.key])} export${Number(rows[0][a.key]) === 1 ? '' : 's'}.`,
          ticket_comment:
            `Hi, I checked this at our end. The user ran ${fmtNumber(rows[0][a.key])} ` +
            'export(s) from CRM in the period checked.',
        };
      }

      // The point of this shaper: a count is a WRONG answer to "did they
      // exfiltrate data". One large unfiltered export at an odd hour is the
      // only row that matters, and it must be named, not averaged away.
      const notable = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => {
          const big = Number(r.ROW_COUNT ?? 0) >= 1000;
          const unfiltered = !r.FILTER_APPLIED || /^(none|null|-)$/i.test(String(r.FILTER_APPLIED));
          const hour = Number(String(r.EXPORTED_AT ?? '').slice(11, 13));
          const odd = Number.isFinite(hour) && (hour >= 0 && hour <= 5);
          return big || (unfiltered && odd);
        });

      const total = rows.reduce((s, r) => s + Number(r.ROW_COUNT ?? 0), 0);

      if (!notable.length) {
        return {
          summary:
            `${fmtNumber(rows.length)} export${rows.length === 1 ? '' : 's'}, ` +
            `${fmtNumber(total)} rows in total — all filtered and none unusually large.`,
          ticket_comment:
            `Hi, I checked this at our end. The user ran ${fmtNumber(rows.length)} export(s) from ` +
            `CRM, totalling ${fmtNumber(total)} records. All of them were filtered exports of ` +
            'modest size, consistent with ordinary day-to-day use. Nothing here looks unusual.',
        };
      }

      const worst = notable.reduce((m, x) =>
        Number(x.r.ROW_COUNT ?? 0) > Number(m.r.ROW_COUNT ?? 0) ? x : m);
      const w = worst.r;
      const routine = rows.length - notable.length;

      const detail =
        `${fmtNumber(w.ROW_COUNT)} rows from ${w.MODULE ?? 'CRM'}` +
        `${(!w.FILTER_APPLIED || /^(none|null|-)$/i.test(String(w.FILTER_APPLIED))) ? ' with no filter applied' : ''}` +
        `${w.EXPORTED_AT ? ` at ${fmtDateTime(w.EXPORTED_AT)}` : ''}` +
        `${w.IP_ADDRESS ? ` from ${w.IP_ADDRESS}` : ''}`;

      return {
        summary:
          `${fmtNumber(rows.length)} exports, and one stands out: ${detail}. ` +
          `The other ${fmtNumber(routine)} ${routine === 1 ? 'was' : 'were'} small and filtered.`,
        ticket_comment:
          `Hi, I checked this at our end. This user ran ${fmtNumber(rows.length)} exports from CRM. ` +
          `${fmtNumber(routine)} of them were small, filtered exports consistent with routine work. ` +
          `One is materially different: ${detail}. ` +
          'Given the size, the absence of a filter and the time of day, we would suggest reviewing ' +
          'that export with the user and, if it was not expected, resetting their credentials and ' +
          'reviewing their export permissions.',
        highlights: notable.map(({ i, r }) => ({
          row: i,
          why: `${fmtNumber(r.ROW_COUNT)} rows` +
            `${(!r.FILTER_APPLIED || /^(none|null|-)$/i.test(String(r.FILTER_APPLIED))) ? ', unfiltered' : ''}` +
            `${r.IP_ADDRESS ? `, from ${r.IP_ADDRESS}` : ''}`,
        })),
      };
    },
  },

  /* ---- 3. a permission question, answered yes or no with a reason ----- */
  {
    id: 'permission-check',
    // A check about ONE PERSON always joins Users. A profile-level query never
    // does - and when it happened to return a single row this shaper claimed
    // it and wrote "The user is on the Administrator profile" about a question
    // that named no user.
    match: ({ tables, columns, ruleId }) =>
      ruleId === 'person-permission-specific' ||
      (!ruleId && tables.includes('Users') && tables.includes('ProfilePermissions') && columns.includes('GRANTED')),
    build: ({ rows, question }) => {
      if (!rows.length) {
        return {
          summary: 'No such permission is configured for that profile.',
          ticket_comment:
            'Hi, I checked this at our end. I could not find that permission against the ' +
            "user's profile at all, which usually means the permission does not apply to " +
            'their edition or the module is not enabled. Could you confirm the exact action ' +
            'they are trying to perform?',
        };
      }

      // A single explicit grant/denial is a definite answer, which is what a
      // "why can't my user do X" ticket needs - "no, and here is why".
      if (rows.length === 1) {
        const r = rows[0];
        const granted = r.GRANTED === true || r.GRANTED === 'true';
        const who = r.FULL_NAME ?? 'The user';
        const profile = r.PROFILE_NAME ?? 'their profile';
        const key = r.PERMISSION_KEY ?? 'that permission';
        const action = String(key).split('.').slice(-1)[0];
        const module = String(key).split('.').slice(-2)[0];

        return {
          summary: granted
            ? `Yes — ${who} is on the "${profile}" profile, which grants ${key}.`
            : `No — ${who} is on the "${profile}" profile, and ${key} is set to denied on it.`,
          ticket_comment: granted
            ? `Hi, I checked this at our end. The user is on the "${profile}" profile, and that ` +
              `profile does allow them to ${action} ${module}. If they are still seeing an error, ` +
              'it is likely to be something other than permissions - could you send us a screenshot ' +
              'of the message they get?'
            : `Hi, I checked this at our end. The user is assigned the "${profile}" profile, and on ` +
              `that profile the permission to ${action} ${module} is switched off. That is why the ` +
              'option is unavailable to them. An administrator can enable it under Setup → Users and ' +
              `Control → Profiles → ${profile}, or move the user to a profile that already has it.`,
          highlights: [{ row: 0, why: granted ? 'granted' : 'denied — this is the answer' }],
        };
      }

      const denied = rows.filter((r) => r.GRANTED === false || r.GRANTED === 'false');
      const grantedRows = rows.filter((r) => r.GRANTED === true || r.GRANTED === 'true');

      if (/delete/i.test(question) && grantedRows.length) {
        const names = [...new Set(grantedRows.map((r) => r.PROFILE_NAME).filter(Boolean))];
        return {
          summary: `${names.length} profile${names.length === 1 ? '' : 's'} can delete records: ${list(names)}.`,
          ticket_comment:
            `Hi, I checked this at our end. Delete permission is granted to ${list(names)}. ` +
            'Any user on one of those profiles can delete records in the modules listed against them.',
        };
      }

      return {
        summary:
          `${fmtNumber(grantedRows.length)} granted, ${fmtNumber(denied.length)} denied ` +
          `across ${fmtNumber(rows.length)} permission rows.`,
        ticket_comment:
          `Hi, I checked this at our end. Of the permissions I looked at, ${fmtNumber(grantedRows.length)} ` +
          `are enabled and ${fmtNumber(denied.length)} are switched off. I can confirm any specific one ` +
          'if you let us know exactly which action the user is attempting.',
      };
    },
  },

  /* ---- 4. department membership --------------------------------------- */
  {
    id: 'department-membership',
    match: ({ tables, columns }) =>
      tables.includes('DESK_DepartmentMembers') || (tables.includes('DESK_Departments') && columns.includes('ROLE_IN_DEPT')),
    build: ({ rows, question }) => {
      const wanted = /should be in (?:the )?([A-Za-z][\w &-]{1,40}?)(?: department)?\b/i.exec(question)?.[1]?.trim();

      if (!rows.length) {
        return {
          summary: 'That user is not a member of any Desk department.',
          ticket_comment:
            'Hi, I checked this at our end. The user is not currently a member of any department ' +
            'in Desk. An administrator can add them under Setup → Departments, choosing the ' +
            'department and the role they should have in it.',
        };
      }

      const names = [...new Set(rows.map((r) => r.DEPARTMENT_NAME).filter(Boolean))];
      const withRoles = rows
        .filter((r) => r.DEPARTMENT_NAME)
        .map((r) => `${r.DEPARTMENT_NAME}${r.ROLE_IN_DEPT ? ` (${r.ROLE_IN_DEPT})` : ''}`);

      // "No" on its own sends the admin back to a debug engineer, which is the
      // round trip this tool exists to remove. Always say what IS true.
      const missing = wanted && !names.some((n) => n.toLowerCase() === wanted.toLowerCase());

      return {
        summary: missing
          ? `Not in ${wanted} — they are in ${list(withRoles)}.`
          : `In ${fmtNumber(names.length)} department${names.length === 1 ? '' : 's'}: ${list(withRoles)}.`,
        ticket_comment: missing
          ? `Hi, I checked this at our end. The user is not a member of the ${wanted} department. ` +
            `They are currently in ${list(names)}${withRoles.length ? ` — specifically ${list(withRoles)}` : ''}. ` +
            `To give them access to ${wanted}, an administrator can add them under ` +
            'Setup → Departments → ' + wanted + ' → Members.'
          : `Hi, I checked this at our end. The user is a member of ${list(names)}` +
            `${withRoles.length ? `, with the roles ${list(withRoles)}` : ''}.`,
      };
    },
  },

  /* ---- 5. field change history ---------------------------------------- */
  {
    id: 'field-history',
    match: ({ tables }) => tables.includes('CRM_FieldHistory'),
    build: ({ rows }) => {
      if (!rows.length) {
        return {
          summary: 'No change has ever been recorded on that field.',
          ticket_comment:
            'Hi, I checked this at our end. There is no change history against that field on the ' +
            'record, which means the value has been the same since the record was created. ' +
            'Nobody has edited it.',
        };
      }
      const r = rows[0];
      const who = r.FULL_NAME ?? 'a user';
      const when = fmtDateTime(r.CHANGED_AT);
      const field = String(r.FIELD_NAME ?? 'the field').toLowerCase().replace(/_/g, ' ');
      return {
        summary:
          `${who} changed ${field} from "${r.OLD_VALUE ?? 'empty'}" to "${r.NEW_VALUE ?? 'empty'}" on ${when}` +
          `${rows.length > 1 ? `, and ${fmtNumber(rows.length - 1)} earlier change${rows.length === 2 ? '' : 's'} before that` : ''}.`,
        ticket_comment:
          `Hi, I checked this at our end. The ${field} on that record was changed on ${when} by ${who}. ` +
          `It was "${r.OLD_VALUE ?? 'empty'}" before the change and "${r.NEW_VALUE ?? 'empty'}" after it` +
          `${rows.length > 1 ? `. There ${rows.length === 2 ? 'was one' : `were ${fmtNumber(rows.length - 1)}`} earlier change(s) to the same field` : ''}.`,
        highlights: [{ row: 0, why: 'the most recent change' }],
      };
    },
  },

  /* ---- 6. dormant users ------------------------------------------------ */
  {
    id: 'dormant-users',
    match: ({ tables, columns, question, ruleId }) =>
      ruleId !== 'active-users' &&
      tables.includes('Users') && columns.includes('LAST_LOGIN') &&
      (ruleId === 'dormant-users' ||
        /log ?in|logged|signed|dormant|inactive/i.test(question)),
    build: ({ rows }) => {
      if (!rows.length) {
        return {
          summary: 'Everyone has logged in within that period.',
          ticket_comment:
            'Hi, I checked this at our end. Every active user in the account has signed in within ' +
            'the period you asked about, so there are no dormant accounts to clean up.',
        };
      }
      const oldest = rows[rows.length - 1];
      return {
        summary:
          `${fmtNumber(rows.length)} ${rows.length === 1 ? 'user has' : 'users have'} not logged in during that period` +
          `${oldest?.LAST_LOGIN ? `, the longest since ${fmtDate(oldest.LAST_LOGIN)}` : ''}.`,
        ticket_comment:
          `Hi, I checked this at our end. ${fmtNumber(rows.length)} user${rows.length === 1 ? ' has' : 's have'} ` +
          'not signed in during the period you asked about. If any of them have left the ' +
          'organisation, deactivating them will free up their licences.',
      };
    },
  },

  /* ---- 7. a single aggregate ------------------------------------------- */
  {
    id: 'single-aggregate',
    match: ({ rows, columns }) =>
      rows.length === 1 && columns.length === 1 && /^(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(columns[0]),
    build: ({ rows, columns, tables, loaded }) => {
      const key = columns[0];
      const value = rows[0][key];
      const noun = nounFor(tables, loaded, Number(value));
      const isCount = /^COUNT/i.test(key);
      return {
        summary: isCount
          ? `${fmtNumber(value)} ${noun}.`
          : `${humanAgg(key)}: ${fmtNumber(value)}.`,
        ticket_comment:
          `Hi, I checked this at our end. The account currently has ${fmtNumber(value)} ${noun}.`,
      };
    },
  },

  /* ---- 8. a grouped breakdown ----------------------------------------- */
  {
    id: 'grouped',
    match: ({ rows, columns }) =>
      rows.length > 1 && rows.length <= 20 &&
      columns.some((c) => /^(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(c)) &&
      columns.some((c) => !/^(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(c)),
    build: ({ rows, columns, tables, loaded }) => {
      const metricKey = columns.find((c) => /^(SUM|AVG|MIN|MAX)\s*\(/i.test(c))
        ?? columns.find((c) => /^COUNT\s*\(/i.test(c));
      const labelKey = columns.find((c) => !/^(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(c));
      const isMoney = /AMOUNT|VALUE|REVENUE|COST/i.test(metricKey ?? '');
      const fmt = isMoney ? fmtMoney : fmtNumber;

      const parts = rows.map((r) => `${r[labelKey] ?? 'not set'} ${fmt(r[metricKey])}`);
      const summable = /^(COUNT|SUM)\s*\(/i.test(metricKey ?? '');
      const total = summable ? rows.reduce((s, r) => s + Number(r[metricKey] ?? 0), 0) : null;
      const unit = /^COUNT/i.test(metricKey ?? '') ? nounFor(tables, loaded, total ?? 2) : humanAgg(metricKey).replace(/^total /, '');

      return {
        summary:
          `${list(parts)}` +
          (total !== null ? ` — ${fmt(total)} ${unit} in total.` : '.'),
        ticket_comment:
          `Hi, I checked this at our end. The breakdown by ${String(labelKey).toLowerCase().replace(/_/g, ' ')} is: ` +
          `${rows.map((r) => `${r[labelKey] ?? 'not set'} (${fmt(r[metricKey])})`).join(', ')}` +
          (total !== null ? `, coming to ${fmt(total)} in total.` : '.'),
      };
    },
  },
  /* ---- email authentication: say the status, not the row count -------- */
  {
    /**
     * "Is DMARC configured for this org?" The engineer asked about ONE
     * mechanism and wants a yes/no per domain. "3 support email configurations
     * matched" makes them read the table to find the answer the question
     * already narrowed to.
     */
    id: 'email-auth',
    match: ({ ruleId }) => ruleId === 'desk-email-auth' || ruleId === 'campaigns-sender-auth',
    build: ({ rows, question, tables }) => {
      if (!rows.length) return null; // GENERIC's "nothing recorded" wording is right
      const asked = ['dmarc', 'dkim', 'spf'].filter((m) => new RegExp(`\\b${m}\\b`, 'i').test(question));
      const mechanisms = asked.length ? asked : ['spf', 'dkim', 'dmarc'];
      const labelCol = rows[0].SENDING_DOMAIN !== undefined ? 'SENDING_DOMAIN' : 'DOMAIN_NAME';
      const noun = tables.includes('CMP_SenderDomains') ? 'sending domains' : 'support email domains';
      const human = (v) => String(v ?? 'unknown').replace(/_/g, ' ');

      const parts = [];
      const lines = [];
      for (const m of mechanisms) {
        const col = `${m.toUpperCase()}_STATUS`;
        const by = new Map();
        for (const r of rows) {
          const k = human(r[col]);
          if (!by.has(k)) by.set(k, new Set());
          by.get(k).add(r[labelCol] ?? r.SUPPORT_EMAIL ?? '?');
        }
        const ok = by.get('verified')?.size ?? 0;
        const notOk = [...by.entries()].filter(([k]) => k !== 'verified');
        const domains = new Set(rows.map((r) => r[labelCol] ?? r.SUPPORT_EMAIL));
        const head = ok === domains.size
          ? `${m.toUpperCase()} is verified on all ${fmtNumber(domains.size)} ${noun}`
          : ok === 0
            ? `${m.toUpperCase()} is not verified on any of the ${fmtNumber(domains.size)} ${noun}`
            : `${m.toUpperCase()} is verified on ${fmtNumber(ok)} of ${fmtNumber(domains.size)} ${noun}`;
        const detail = notOk.map(([k, ds]) => `${k}: ${list([...ds].slice(0, 5))}`).join('; ');
        parts.push(detail ? `${head} (${detail})` : head);
        lines.push(detail ? `${head} - ${detail}.` : `${head}.`);
      }
      const policy = mechanisms.includes('dmarc') && rows.some((r) => r.DMARC_POLICY)
        ? ` DMARC policy: ${list([...new Set(rows.map((r) => r.DMARC_POLICY).filter(Boolean))])}.`
        : '';
      return {
        summary: `${parts.join('. ')}.${policy}`,
        ticket_comment:
          `Hi, I checked the email authentication on the account. ${lines.join(' ')}${policy}` +
          (parts.some((p) => /not verified|pending|failed|not configured/.test(p))
            ? ' The records that are not verified need to be added at your DNS provider before mail from those domains is fully trusted.'
            : ''),
      };
    },
  },
];

/* ---- generic fallback, always works ---------------------------------- */
const GENERIC = {
  id: 'generic',
  build: ({ rows, columns, tables, loaded }) => {
    const noun = nounFor(tables, loaded, rows.length);
    if (!rows.length) {
      // A configuration table read whole ("has DMARC been configured") with
      // zero rows is NOT a "no" - it means nothing is recorded for this
      // customer, which is what the sentence has to say. "No support email
      // configurations match that" reads as "DMARC is not set up", a confident
      // claim the data cannot support.
      const config = tables.every((t) => loaded.byTable.get(t)?.listable);
      return config
        ? {
          summary: `No ${noun} are recorded for this customer.`,
          ticket_comment:
            `Hi, I checked this at our end and there are no ${noun} recorded on the account ` +
            'yet. If you expected some, let us know and we will look into how they were set up.',
        }
        : {
          summary: `No ${noun} match that.`,
          ticket_comment:
            'Hi, I checked this at our end and could not find any records matching that ' +
            'description. Could you confirm the exact record id or name you are looking at?',
        };
    }
    const label = labelColumn(columns);
    if (label && rows.length <= 12) {
      const names = [...new Set(rows.map((r) => r[label]).filter(Boolean))];
      return {
        summary: `${fmtNumber(rows.length)} ${noun}: ${list(names.slice(0, 8))}${names.length > 8 ? ` and ${names.length - 8} more` : ''}.`,
        ticket_comment:
          `Hi, I checked this at our end. I found ${fmtNumber(rows.length)} matching ${noun}: ` +
          `${names.slice(0, 10).join(', ')}${names.length > 10 ? ', and others' : ''}.`,
      };
    }
    return {
      summary: `${fmtNumber(rows.length)} ${noun} matched.`,
      ticket_comment:
        `Hi, I checked this at our end. I found ${fmtNumber(rows.length)} matching ${noun} in the account.`,
    };
  },
};

/* -------------------------------------------------------------- helpers */

function labelColumn(columns) {
  const preferred = [
    'FULL_NAME', 'DEPARTMENT_NAME', 'PROFILE_NAME', 'PERMISSION_KEY', 'ACCOUNT_NAME',
    'DEAL_NAME', 'SEGMENT_NAME', 'LIST_NAME', 'CAMPAIGN_NAME', 'SUBJECT', 'LEAD_ID', 'EMAIL',
  ];
  for (const p of preferred) if (columns.includes(p)) return p;
  return columns.find((c) => /_NAME$/.test(c)) ?? null;
}

function nounFor(tables, loaded, count) {
  const plural = count !== 1;
  const def = loaded?.byTable?.get(tables[0]);
  const label = def?.label ?? 'record';
  if (!plural && label.endsWith('s')) return label.replace(/s$/, '');
  return plural && !label.endsWith('s') ? `${label}s` : label;
}

function humanAgg(key) {
  const m = /^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*([\w.]+)\s*\)$/i.exec(String(key).trim());
  if (!m) return String(key);
  const word = { COUNT: 'count', SUM: 'total', AVG: 'average', MIN: 'lowest', MAX: 'highest' }[m[1].toUpperCase()];
  const inner = m[2].replace(/^\w+\./, '').replace(/_/g, ' ').toLowerCase();
  return /^rowid$/i.test(inner) ? word : `${word} ${inner}`;
}

/* ------------------------------------------------------------------ build */

/**
 * Build summary, ticket comment and highlights for one result set.
 *
 * The freshness caveat is appended to BOTH the summary and the ticket comment,
 * but only when lag exceeds the threshold - saying "as of 0 seconds ago" on
 * every reply is noise that trains people to ignore the line that matters.
 */
function build({ question, rows, columns, tables, loaded, replica, engine = '' }) {
  const ctx = {
    question: String(question ?? ''), rows, columns, tables, loaded, replica,
    engine: String(engine ?? ''),
    /** The rule id behind `rules:<id>`, or '' when the model wrote the query. */
    ruleId: /^rules:(.+)$/.exec(String(engine ?? ''))?.[1] ?? '',
  };
  const shaper = SHAPERS.find((s) => {
    try { return s.match(ctx); } catch { return false; }
  }) ?? GENERIC;

  let out;
  try {
    out = shaper.build(ctx);
  } catch (err) {
    console.warn(`shaper ${shaper.id} failed, using generic: ${err.message}`);
    out = GENERIC.build(ctx);
  }

  const asOfText = fmtDateTime(replica?.as_of ?? new Date().toISOString());
  let summary = out.summary;
  let comment = out.ticket_comment;

  if (replica?.stale) {
    const mins = Math.round(replica.lag_seconds / 60);
    const behind = mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${replica.lag_seconds} seconds`;
    summary += ` (Reading is about ${behind} behind live — a very recent edit may not show yet.)`;
    comment += ` Please note this reflects our records as of a few minutes ago; a change made in the last ${behind} may not be included.`;
  }

  return {
    summary: sentence(summary),
    ticket_comment: `${sentence(comment)} — as of ${asOfText}`,
    highlights: out.highlights ?? [],
    shaper: shaper.id,
    as_of_text: asOfText,
  };
}

module.exports = { build, SHAPERS, GENERIC, fmtDate, fmtDateTime, fmtNumber, fmtMoney, humanAgg, labelColumn, sentence };
