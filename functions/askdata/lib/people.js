'use strict';

/**
 * Resolving the person a question names - and refusing to guess.
 *
 * Support engineers type first names, because that is what customers write in
 * tickets: "can you check whether Ashwin exported anything". Real orgs have two
 * Ashwins.
 *
 * WHY THIS IS A HARD RULE AND NOT A NICETY. The question this most often serves
 * is "did this employee take data before they left". Answering it about the
 * wrong employee produces a false accusation against a real person, delivered to
 * their employer, with a query log behind it that makes it look authoritative.
 * So when a name matches more than one person, this returns every candidate and
 * the caller returns `mode:"clarify"`. It never picks the first row, the most
 * active one, or the closest fuzzy match. One extra question is cheap; that
 * outcome is not.
 *
 * The same applies to any non-unique label - deal names, list names, department
 * names, company names - via `resolveLabel`.
 *
 * Matching happens here, in JavaScript, rather than in the query: ZCQL's LIKE
 * matches nothing at all in this engine, so `WHERE FULL_NAME LIKE '%Ashwin%'`
 * would return zero rows and read as "no such person". The roster is read once
 * per org and matched in memory; what reaches the Data Store is always an exact
 * `= 'Ashwin Prakash'`.
 */

const { flattenRows } = require('./replica');
const { maskValue } = require('./mask');

const TTL_MS = 60 * 1000;
const cache = new Map();

const q = (v) => String(v ?? '').replace(/'/g, "''");

/** Words that are never part of a person's name in these questions. */
const NOISE = new Set([
  'the', 'a', 'an', 'user', 'users', 'employee', 'employees', 'person', 'people',
  'staff', 'agent', 'agents', 'member', 'customer', 'this', 'that', 'their',
  'his', 'her', 'they', 'them', 'is', 'are', 'was', 'were', 'has', 'have', 'had',
  'did', 'does', 'do', 'can', 'could', 'would', 'should', 'any', 'data', 'from',
  'export', 'exported', 'exports', 'crm', 'campaigns', 'desk', 'in', 'on', 'at',
  'to', 'for', 'of', 'and', 'or', 'not', 'no', 'yes', 'check', 'checking',
  'asking', 'says', 'said', 'whether', 'if', 'about', 'account', 'org', 'admin',
  'department', 'departments', 'segment', 'segments', 'lead', 'leads', 'ticket',
  'anything', 'something', 'me', 'we', 'our', 'you', 'your', 'be', 'been', 'but',
]);

function normalise(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whole-word (or whole-phrase) containment.
 *
 * Boundaries matter more than they look: "Chen Wei" must not be found inside
 * "Chennai", and "Ben" must not be found inside "benefit".
 */
function hasWord(haystack, needle) {
  if (!needle) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(haystack);
}

/** The org's people, cached briefly - read on every question, changes rarely. */
async function roster(catalystApp, orgId) {
  const hit = cache.get(orgId);
  if (hit && Date.now() < hit.expiresAt) return hit.people;

  const result = await catalystApp.zcql().executeZCQLQuery(
    `SELECT USER_ID, ZUID, FULL_NAME, EMAIL, STATUS, LAST_LOGIN FROM Users ` +
    `WHERE ORG_ID = '${q(orgId)}' LIMIT 0, 300`
  );
  const people = flattenRows(result).filter((p) => p && p.FULL_NAME);
  cache.set(orgId, { people, expiresAt: Date.now() + TTL_MS });
  return people;
}

/**
 * Who does this question name?
 *
 * Tiered, strongest evidence first, stopping at the first tier that hits - so a
 * question naming someone in full is never re-read as a loose first-name match
 * on somebody else.
 *
 * Returns null when no one is named, else
 * `{ matches, tier, ambiguous, term }`.
 */
function findPeople(question, people) {
  const text = normalise(question);
  if (!text || !people.length) return null;

  // 1. an exact user id or ZUID - unambiguous by construction
  const byId = people.filter(
    (p) => (p.USER_ID && hasWord(text, normalise(p.USER_ID))) ||
      (p.ZUID && hasWord(text, normalise(p.ZUID)))
  );
  if (byId.length === 1) return { matches: byId, tier: 'user id', ambiguous: false, term: byId[0].USER_ID };

  // 2. the whole name as stored
  const byFull = people.filter((p) => hasWord(text, normalise(p.FULL_NAME)));
  if (byFull.length === 1) return { matches: byFull, tier: 'full name', ambiguous: false, term: byFull[0].FULL_NAME };
  if (byFull.length > 1) return { matches: byFull, tier: 'full name', ambiguous: true, term: normalise(byFull[0].FULL_NAME) };

  // 3. the email local part
  const byEmail = people.filter((p) => {
    const local = normalise(String(p.EMAIL ?? '').split('@')[0]);
    return local.length >= 3 && hasWord(text, local);
  });
  if (byEmail.length === 1) return { matches: byEmail, tier: 'email', ambiguous: false, term: byEmail[0].EMAIL };

  // 4. surname, then 5. first name. Tokens under three characters are ignored -
  //    a two-letter fragment matches too much ordinary English to be evidence.
  for (const which of ['surname', 'first name']) {
    const buckets = new Map();
    for (const p of people) {
      const parts = normalise(p.FULL_NAME).split(' ').filter(Boolean);
      const tok = which === 'surname' ? parts[parts.length - 1] : parts[0];
      if (!tok || tok.length < 3 || NOISE.has(tok) || !hasWord(text, tok)) continue;
      if (!buckets.has(tok)) buckets.set(tok, []);
      buckets.get(tok).push(p);
    }
    if (!buckets.size) continue;
    const [term, group] = [...buckets.entries()][0];
    return { matches: group, tier: which, ambiguous: group.length > 1, term };
  }

  return null;
}

/**
 * The clarify payload for an ambiguous name.
 *
 * Carries enough to tell the candidates apart while still masked (rule 3): the
 * name mask keeps the surname initial, so "Ashwin P." and "Ashwin M." are
 * distinguishable, and last login separates them further. `suggestion` is the
 * engineer's own question with the fragment replaced by the full name, so
 * choosing is one click rather than retyping.
 */
function clarifyCandidates(found, question) {
  return found.matches.map((p) => ({
    user_id: p.USER_ID,
    full_name: maskValue(p.FULL_NAME, 'name'),
    email: maskValue(p.EMAIL, 'email'),
    status: p.STATUS,
    last_login: p.LAST_LOGIN ?? null,
    suggestion: replaceTerm(question, found.term, p.FULL_NAME),
  }));
}

function replaceTerm(question, term, replacement) {
  if (!term) return `${question} (${replacement})`;
  const esc = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, 'i');
  return re.test(question)
    ? question.replace(re, (m, a, b) => `${a}${replacement}${b}`)
    : `${question} (${replacement})`;
}

/**
 * The same rule for any non-unique label: a deal name, list name, department
 * name or company. Returns { matches, ambiguous } or null.
 */
function resolveLabel(question, rows, column) {
  const text = normalise(question);
  const hits = rows.filter((r) => r[column] && hasWord(text, normalise(r[column])));
  if (!hits.length) return null;
  return { matches: hits, ambiguous: hits.length > 1, column };
}

function forget(orgId) {
  if (orgId === undefined) cache.clear();
  else cache.delete(orgId);
}

module.exports = { roster, findPeople, clarifyCandidates, resolveLabel, replaceTerm, normalise, hasWord, forget };
