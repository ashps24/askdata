'use strict';

/**
 * Typo and misspelling tolerance for the question box.
 *
 * Support engineers type fast, in a hurry, often in a second language, into a
 * box on a ticket screen. "wich users has permision to creat leads" is a
 * perfectly clear question that the rule engine could not see at all, because
 * every rule matches on substrings and not one of those substrings survived.
 *
 * WHY THIS IS SPELLING CORRECTION AND NOT A MODEL CALL
 *
 * The model translator sits in front of the rules and handles far more than
 * typos - but it is a network call to a service that can be slow, refused, or
 * simply not provisioned in a given project, and this has to work when it is
 * none of those things. Correction here is deterministic, costs nothing, and
 * runs before both engines, so the model gets a cleaner prompt too.
 *
 * WHAT KEEPS IT FROM CHANGING THE MEANING
 *
 * The lexicon is the schema's own words plus the vocabulary the rules match
 * on - not a general dictionary - so "leds" can only become a word this app
 * understands. On top of that:
 *
 *   a token already in the lexicon is never touched;
 *   anything holding a digit is left alone (ids, dates, org ids);
 *   short tokens are left alone, where one edit is most of the word;
 *   a tie between two candidates is left alone rather than guessed;
 *   if too much of the sentence would change, nothing is changed at all -
 *     that is the signal we are not reading English, and mangling it would be
 *     worse than admitting we did not understand.
 *
 * Every correction is reported back, so the engineer sees what was read.
 */

/**
 * Words the rules and the guard actually key on, beyond the schema's own.
 * Question shapes ("how many", "which"), time units, and the permission verbs.
 */
const BASE_LEXICON = [
  // question shapes
  'how', 'many', 'much', 'which', 'what', 'who', 'whom', 'whose', 'when', 'where',
  'why', 'show', 'list', 'give', 'tell', 'find', 'get', 'need', 'want', 'know',
  'count', 'total', 'number', 'all', 'every', 'each', 'any', 'some', 'none',
  'have', 'has', 'had', 'does', 'did', 'can', 'cannot', 'could', 'should', 'would',
  'is', 'are', 'was', 'were', 'been', 'being', 'the', 'this', 'that', 'these',
  'those', 'with', 'without', 'from', 'into', 'about', 'there', 'their', 'them',
  'they', 'been', 'still', 'also', 'only', 'more', 'most', 'least', 'than',
  // people
  'user', 'users', 'people', 'person', 'agent', 'agents', 'employee', 'employees',
  'staff', 'member', 'members', 'admin', 'admins', 'administrator', 'everyone',
  'anybody', 'anyone', 'somebody', 'nobody',
  // access
  'permission', 'permissions', 'permitted', 'profile', 'profiles', 'role', 'roles',
  'access', 'granted', 'denied', 'allowed', 'enabled', 'disabled', 'able', 'unable',
  // activity
  'active', 'inactive', 'dormant', 'stale', 'idle', 'login', 'logins', 'logged',
  'signed', 'activity', 'audit', 'history', 'recent', 'recently', 'last', 'past',
  'previous', 'latest', 'never', 'always',
  // time
  'day', 'days', 'week', 'weeks', 'fortnight', 'month', 'months', 'quarter',
  'quarters', 'year', 'years', 'today', 'yesterday', 'ago', 'since', 'during',
  'between', 'before', 'after',
  // verbs the permission catalogue uses
  'create', 'created', 'delete', 'deleted', 'edit', 'edited', 'update', 'updated',
  'modify', 'export', 'exported', 'import', 'view', 'read', 'write', 'share',
  'approve', 'assign', 'assigned', 'change', 'changed', 'convert', 'merge',
  // things
  'lead', 'leads', 'contact', 'contacts', 'account', 'accounts', 'deal', 'deals',
  'ticket', 'tickets', 'department', 'departments', 'segment', 'segments',
  'campaign', 'campaigns', 'record', 'records', 'module', 'modules', 'field',
  'fields', 'source', 'sources', 'stage', 'stages', 'status', 'owner', 'value',
  'amount', 'pipeline', 'revenue', 'company', 'organisation', 'organization',
  'org', 'email', 'emails', 'phone', 'name', 'names', 'licence', 'license',
];

/** Tokens that must never be treated as misspellings. */
const SKIP = /[\d@]|^[a-z]{1,3}$/;

/**
 * Damerau-Levenshtein, bounded.
 *
 * Bounded because the answer is only ever compared against a small maximum -
 * computing an exact distance of 9 costs the same as discovering it is "more
 * than 2", across a lexicon of several hundred words, for every token.
 */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const row = new Array(b.length + 1);
    row[0] = i;
    let best = row[0];

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      // Transposition: "teh" -> "the" is one edit, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], prev2[j - 2] + 1);
      }
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

/** One edit for a short word, two once there is enough word to be sure. */
function toleranceFor(word) {
  if (word.length < 4) return 0;
  if (word.length < 7) return 1;
  return 2;
}

/**
 * The closest lexicon word, or null when there isn't an unambiguous one.
 * A tie is deliberately null: guessing between "deals" and "details" produces
 * a confident answer to a question nobody asked.
 */
function nearest(word, lexicon) {
  const max = toleranceFor(word);
  if (!max) return null;

  let best = null;
  let bestDistance = max + 1;
  let tied = false;

  for (const candidate of lexicon) {
    const d = editDistance(word, candidate, max);
    if (d > max) continue;
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
      tied = false;
    } else if (d === bestDistance && candidate !== best) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/** The lexicon for a loaded pack view: the base words plus the schema's own. */
function lexiconFor(loaded) {
  const words = new Set(BASE_LEXICON);

  for (const table of loaded?.tables ?? []) {
    for (const part of String(table.label ?? '').toLowerCase().split(/[^a-z]+/)) {
      if (part.length > 2) words.add(part);
    }
    for (const column of table.columnNames ?? []) {
      for (const part of column.toLowerCase().split(/[^a-z]+/)) {
        if (part.length > 2) words.add(part);
      }
    }
    for (const column of table.columns ?? []) {
      for (const value of column.values ?? []) {
        for (const part of String(value).toLowerCase().split(/[^a-z]+/)) {
          if (part.length > 2) words.add(part);
        }
      }
    }
  }

  for (const [key, alternatives] of Object.entries(loaded?.synonyms ?? {})) {
    for (const phrase of [key, ...alternatives]) {
      for (const part of String(phrase).toLowerCase().split(/[^a-z]+/)) {
        if (part.length > 2) words.add(part);
      }
    }
  }
  return words;
}

/** Too much rewriting means we are not reading English. Leave it alone. */
const MAX_CORRECTED_SHARE = 0.4;

/**
 * Correct a question against the app's own vocabulary.
 *
 * Returns the text unchanged when there is nothing confident to do, along with
 * the list of substitutions made so the caller can show its work.
 */
function correct(question, loaded) {
  const original = String(question ?? '');
  if (!original.trim()) return { text: original, corrections: [], changed: false };

  const lexicon = lexiconFor(loaded);
  const corrections = [];
  let words = 0;

  const text = original.replace(/[A-Za-z][A-Za-z'’]*/g, (token) => {
    const lower = token.toLowerCase();
    words += 1;
    if (SKIP.test(lower) || lexicon.has(lower)) return token;
    // A possessive or contraction: check the stem before giving up.
    const stem = lower.replace(/['’]s$/, '');
    if (lexicon.has(stem)) return token;

    const fix = nearest(lower, lexicon);
    if (!fix || fix === lower) return token;

    corrections.push({ from: token, to: fix });
    // Preserve the shape the engineer typed.
    return token[0] === token[0].toUpperCase()
      ? fix[0].toUpperCase() + fix.slice(1)
      : fix;
  });

  if (!corrections.length) return { text: original, corrections: [], changed: false };

  if (corrections.length / Math.max(words, 1) > MAX_CORRECTED_SHARE) {
    return { text: original, corrections: [], changed: false, abandoned: true };
  }
  return { text, corrections, changed: true };
}

module.exports = { correct, lexiconFor, editDistance, nearest, BASE_LEXICON };
