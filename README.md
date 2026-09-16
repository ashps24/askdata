# AskData

An internal tool for Zoho support engineers. Connect to a customer's org, ask a
question in plain English, get the answer plus a sentence to paste into the
ticket — without escalating to a debug engineer.

**The support engineer does not know SQL and must never need to.** Every design
decision below follows from that. A refusal that contains ZCQL, a "fix your
query" prompt, or a syntax hint is a failure of the tool, not of the user — so
the guard produces two separate outputs: a plain-English `reason` for the
engineer and a technical `verdict` for the audit log.

---

## Status

**Live.** https://askdata-876513394.development.catalystserverless.com/app/index.html
Project `AskData` / `30663000000121440` · org `876513394` · Development · US DC.

```bash
cd functions/askdata && npm install && cd ../..
catalyst deploy --org 876513394
```

`node scripts/provision-payloads.mjs` prints the 21 table and 168 column
payloads for the MCP calls, derived from the packs so the Data Store schema and
the guard's allow-list cannot drift apart.

### What still needs you

Two things are blocked on actions only you can take. Neither stops the app
working — every question in the Starters panel is answered today.

**1. Data Store write allowances are exhausted.** Reads, updates and deletes
still work, so the app answers normally. Two consequences:

*Sample data* was loaded through bulk write, which is metered separately from
row inserts - `/admin/bulk-seed` generates a CSV per table, uploads it and
starts a job. All ten companies are loaded. That allowance is now spent too.

*Audit rows* are no longer lost. `insertRow` fails, so `lib/spool.js` holds each
entry in Stratus instead - one object per entry, durable and enumerable - and
`/audit` merges them in, marked `pending`, so a reviewer sees the whole trail.
`/admin/audit-drain` moves them into `SupportQueryLog` by bulk write and deletes
them only once the rows have landed; it is waiting on the same allowance.

Enable a payment method on the project, then drain the spool and, if you want
to reload the sample data from scratch:

```bash
BASE=https://askdata-876513394.development.catalystserverless.com/server/askdata
curl -s -X POST "$BASE/admin/audit-drain" -H 'x-askdata-admin: askdata-dev-admin-2026' \
     -H 'Content-Type: application/json' -d '{}'
```


```bash
BASE=https://askdata-876513394.development.catalystserverless.com/server/askdata
curl -s -X POST "$BASE/admin/seed" -H 'x-askdata-admin: askdata-dev-admin-2026' \
     -H 'Content-Type: application/json' -d '{"audit_per_org":60}'
curl -s -X POST "$BASE/admin/provision-refs" -H 'x-askdata-admin: askdata-dev-admin-2026'
```

That is ~6,350 inserts for all ten companies across 44 tables - including the
24 configuration tables (Desk email authentication, Guided Conversations,
custom functions, assignment rules, help centers; Campaigns sender domains,
journeys, forms, A/B tests; CRM workflow, assignment, blueprint, duplicate and
sharing rules; and the Zoho Directory pack) which exist in the Data Store but
hold no rows until this runs. The seeder probes with a single
row first and **refuses to start if writes are unavailable**, because it wipes
each table before refilling it — an earlier run lost four stages that way.

**2. The model translator needs a Connection only you can authorize.**
Catalyst console → project **AskData** → **Connections** → create one named
exactly **`quickmlcon`** with scope **`QuickML.deployment.READ`**, and
authorize it. It cannot be created from the CLI or MCP: it needs an OAuth
client secret and an interactive consent grant.

`ASKDATA_QUICKML_PROJECT_ID` is already pointed at `30663000000079001`
(`tam-qbr`), the only project in this org where QuickML is enabled — GLM
serving is provisioned per project, and AskData's own project is not one, so
leaving it unset would 404 *after* the Connection started working and look
like a broken Connection.

Check both at any time with `GET /diag`, which reports each step, what is
still missing, and the exact next action — without printing any token
material:

```json
{ "setup": { "ready": false,
             "next": "Catalyst console -> ... create one named exactly \"quickmlcon\" ...",
             "fallback": "32 deterministic rules, labelled \"rules\" on every answer." } }
```

Until the Connection exists every answer is labelled **`RULES`**, so nobody
mistakes a pattern-matched answer for a translated one. Misspellings are still
handled — `lib/spell.js` corrects against the schema's own lexicon before
either engine runs, and is deliberately independent of the model for exactly
this reason.

### What is real, and what is modelled

Three things in the design cannot be implemented literally here. They are
modelled with a working seam rather than faked, and the code says so at the
point it matters.

| Design | Reality | What this does |
|---|---|---|
| Reads hit a regional read replica | Catalyst Data Store has no replica concept, and there are no per-customer DB credentials to resolve | `dc` **is** resolved from the org record and carried everywhere; `as_of` **is** real; `lag_seconds` comes from config (`ASKDATA_LAG_<DC>`) so the freshness path is live code, and `replica_source` states which it was. `lib/replica.js:read()` is the single seam a real client would replace. |
| Engineer entitlement from open tickets / elevated grants | No ticketing system is wired in | A `SupportEntitlements` table the connect check reads, which production backs with the real ticket source. Both paths (open ticket, elevated access) are seeded and exercised, and a *closed* ticket is seeded to prove it does not entitle. |
| Refuse un-indexed scans | `search_index_enabled` is unrelated to ZCQL planning | Pack-declared `indexed` columns, enforced by the guard on the model's own WHERE — before injection, since `ORG_ID` is indexed and would otherwise make every query pass. |

Engineer identity comes from the Catalyst-authenticated user. Because the demo
client is unauthenticated, there is an `X-AskData-Engineer` header fallback that
is **refused when `ASKDATA_ENV=Production`**, and the source is recorded on the
grant and in every audit row so a reviewer can see which sessions used it.

---

## The four non-negotiables, and where each lives

### 1. Read-only, always

`lib/rules.js` refuses mutation intent on the *question*, before any
translation — this is a product boundary, not a guard concern. `lib/guard.js`
then refuses any non-SELECT verb and marks it a security event. There is no
write path to disable, no confirm flow, nothing to be sure about.

A question implying a change gets the escalation drafted rather than a dead end.

### 2. The tenant boundary comes from the grant, not the session

A support engineer's Catalyst session belongs to Zoho and has no customer org.
So `POST /connect` verifies entitlement *now* and issues an HMAC-SHA256 grant
bound to `{engineer, zgid, ticket}`, valid 30 minutes.

**`/ask` takes a `grant_token` and no org of any kind.** A tampered body has
nothing to tamper with. Verified: rewriting the org inside the payload and
keeping the signature is refused as `bad_signature`; re-signing with another
secret is refused; expiry is enforced; signatures are compared with
`timingSafeEqual`.

`ORG_ID` is then **injected, not checked**. Verifying that the model remembered
to scope a query fails *open* the moment it forgets — the query runs across
every customer. Injection fails *closed*. Any `ORG_ID` the model wrote is
stripped first; one tangled inside an `OR` is refused rather than rewritten,
because rewriting it could quietly change the filter's meaning.

### 3. PII is masked server-side

`lib/mask.js` runs after the query and before serialisation. A masked value that
reached the browser in the clear is in devtools, the HAR file and every proxy
log on the way.

| Kind | Raw | Rendered |
|---|---|---|
| Email | `ashwin.prakash@northwind.com` | `a•••••••••••••@northwind.com` |
| Phone | `+91 98400 12345` | `+91 •••••• •2345` |
| Name | `Ashwin Prakash` | `Ashwin P.` |

The name mask keeps the surname initial deliberately: it is what lets an
engineer tell `Ashwin P.` from `Ashwin M.` in a clarify list while both stay
masked. `/reveal` un-masks **one row**, never a column, and writes a
`pii_reveal` audit row naming engineer, org, record, columns and ticket — the
trail is the deterrent, and a bulk reveal would make it meaningless.
Aggregates over PII (`COUNT(EMAIL)`) are never masked; there is no personal data
in a count.

`IP_ADDRESS` is deliberately **not** tagged PII: the spec's schema does not mark
it, and the exfiltration question needs `203.0.113.77` visible to distinguish
one export from three routine ones.

### 4. Never resolve an ambiguous person silently

Support engineers type first names, because that is what customers write.
`lib/people.js` resolves against the org's roster and returns **every**
candidate when more than one matches; `/ask` returns `mode:"clarify"` with full
name, email and last login. It never takes the first row, the most active one,
or the best fuzzy match.

This earns its place: the question it most often serves is "did this employee
take data before they left". Answered about the wrong employee it is a false
accusation against a real person, delivered to their employer, with a query log
behind it that makes it look authoritative. The same rule applies to any
non-unique label — account names go through `resolveLabel`.

Matching happens in JavaScript, not in the query, because **ZCQL's `LIKE`
matches nothing at all** — `WHERE FULL_NAME LIKE '%Ashwin%'` returns zero rows
and reads as "no such person". What reaches the Data Store is always
`= 'Ashwin Prakash'`.

### 5. Everything is audited, including the failures

Every `/ask` writes a `SupportQueryLog` row — answered, refused, clarified or
errored — with engineer, ZGID, ticket, the question as typed, the generated
ZCQL, the guard verdict, row count, latency and outcome. Security-relevant
refusals additionally log a `[SECURITY]` line for alerting. The audit write
never throws: a correctly answered question must not become a 500 because the
log timed out, but a failure is loud in the function log.

---

## Product packs

No product is hardcoded. Adding Zoho Projects means writing
`lib/packs/projects.js` and adding one line to `lib/packs/index.js`. A pack
declares tables, synonyms, PII columns and few-shot questions; five consumers
read those declarations — provisioning, the guard's allow-list, the prompt's
schema card, masking, and the seeder — so they cannot drift apart.

The engine loads **only** the packs the connected org subscribes to. That is an
accuracy decision as much as a tidiness one: a card listing 200 tables across 15
products produces measurably worse ZCQL than one listing the 14 tables the
customer actually has. It is also a correctness boundary — asking about
`CMP_Segments` while connected to Fabrikam (no Campaigns) is **refused**, never
answered "0 segments", because 0 reads to a customer as "you have none".

Shipped: `platform` (always), `crm`, `campaigns`, `desk` — 21 tables, 168
columns, 22 foreign keys.

## ZCQL constraints this is built around

All verified live on this platform. Each one returns wrong or empty results
rather than erroring, which is what makes them dangerous.

| Constraint | Consequence here |
|---|---|
| Joins work **only** along a declared foreign key, `child.X_REF = Parent.ROWID`. A join on two matching business-key columns is refused. | Every table carries both a business key (what people say) and a `_REF` FK (what joins). The guard validates each `ON` against the declared refs, turning an opaque engine error into a sentence. |
| **`LIKE` matches nothing** — even indexed, even on a fresh row | Guard refuses it; name and label resolution happen in the app. |
| `COUNT(DISTINCT x)` silently drops the DISTINCT and counts rows | Never emitted; the prompt forbids it explicitly. |
| Aggregate aliases are discarded; `ORDER BY <alias>` then fails | Order by the expression; `lib/answer.js` reads `COUNT(ROWID)` as a key. |
| Org-scoping an outer-joined table in `WHERE` demotes it to an inner join | Outer-joined tables get `(x.ORG_ID = '…' OR x.ROWID IS NULL)`. |
| Booleans cross the wire as `'true'`/`'false'` on some paths, real booleans on others | Normalised once in `lib/replica.js`. |
| Data Store refuses `PRIORITY` and `RESULT` as column names | `DESK_Tickets.TICKET_PRIORITY`, `AuditEvents.OUTCOME`; `askedAs` teaches the prompt the word people use. |
| A `boolean` column requires `default_value` or the whole batch fails with a bare `PATTERN_NOT_MATCHED` | Handled in `scripts/provision-payloads.mjs`. |
| The `description` property rejects `\|`, `;` and `=` with the same error | Descriptions sanitised in the same place. |

**Timezone.** Data Store datetimes are naive, in the project timezone. Writing
from `toISOString()` (UTC) and rendering "in IST" shifts everything by 5:30 —
the 02:14 export would be reported as 07:44, which is not a rounding error but
the wrong fact, and the fact the security answer turns on. So `lib/time.js` is
the only way a `Date` becomes a stored string, and formatting never converts.

## The answer format

Every answer returns three things, and the third earns adoption:

1. **`summary`** — one plain sentence for the engineer.
2. **`rows` + `columns`** — the grid, masked, with per-row Reveal and flagged
   rows for anything notable.
3. **`ticket_comment`** — a paste-ready reply *for the customer*: no table
   names, no field names in schema casing, no ZCQL, no replica jargon, no
   internal ids beyond the one the customer supplied, ending in an "as of".

All of it is **computed, not generated** — no second model call. Latency is one
reason; the decisive one is that a model asked to summarise rows will
occasionally assert something the rows contradict, and a confidently wrong
sentence pasted into a customer's ticket is the worst output this tool could
produce.

`lib/answer.js` holds a shaper per escalation pattern, not per table, because
"did this person export data" and "list the exports" want very different
sentences from identical rows. The export shaper is the clearest case: a count
("4 exports") is a *wrong* answer to the exfiltration question, because it hides
the only row that matters. It names the outlier and separates it from the
routine ones.

## Routes

| Route | Purpose |
|---|---|
| `POST /connect` | `{zgid, ticket_id}` → grant token, org, DC, products, countdown |
| `POST /ask` | `{grant_token, question, history[]}` → `answer` \| `clarify` \| `refused` |
| `POST /reveal` | `{grant_token, table, row_id, columns[]}` → values. Audited, per row. |
| `POST /escalate` | `{grant_token, question}` → ZCQL + an internal note for a debug engineer |
| `GET /audit` | The `SupportQueryLog`, with outcome counts |
| `GET /health`, `GET /diag` | Packs, translator config, Connection reachability |
| `POST /admin/seed`, `/admin/provision-refs` | Staged seeding, token-gated |

`/escalate` is what makes this safe to adopt. Note the audience switch: the
`ticket_comment` from `/ask` is for the customer and never contains a query;
the one from `/escalate` is for a Zoho debug engineer, so ZCQL is exactly what
belongs in it.

## Seed data

Three orgs, sized differently so tenant isolation is testable, and shaped around
the real escalations. A generator producing plausible-but-random rows cannot
demonstrate a correct answer, so the facts the questions turn on are written
explicitly and deterministic filler surrounds them.

| ZGID | Org | DC | Products | Shaped for |
|---|---|---|---|---|
| `60021847312` | Northwind Traders | in | crm, campaigns, desk | lead source, the export question |
| `60021847313` | Contoso Ltd | com | crm, campaigns | the Campaigns permission question |
| `60021847314` | Fabrikam Inc | eu | crm, desk | the Desk department question |

2,797 rows. The load-bearing specifics:

- lead **4551000000234017** — source `Trade Show`, created 12 Aug 2026,
  `MODIFIED_ON` equal to `CREATED_ON` so "no change since creation" is *true*
- lead **4551000000234021** — source changed `Web Form` → `Referral`, with
  matching `CRM_FieldHistory`
- exactly **5** Northwind leads with a `NULL` source, plus some `Import`
- **Ashwin Prakash** (`U-1007`) — three small filtered exports, and one
  **4,000-row unfiltered Contacts export at 02:14 from 203.0.113.77**
- **Ashwin Menon** (`U-1019`) — same first name, ordinary activity only. This
  collision is load-bearing: without a second Ashwin, rule 4 is untestable
- **Meera Raman** (`U-2004`, Contoso) — profile `Marketing Executive` with
  `campaigns.segments.create` = **false**
- **Rahul Iyer** (`U-3005`, Fabrikam) — in **Billing** and **Technical**, not in
  Escalations
- a few leads with `MODIFIED_ON` minutes old, so replica-lag realism has
  something to bite on

## Verified so far (offline)

| Area | Result |
|---|---|
| Guard — must pass | 13/13 including the 4-join permission chain, LEFT JOIN, aggregates, lowercase table correction, and stripping a model-written `ORG_ID` |
| Guard — must refuse | 15/15: write verb, subquery, `UNION`, 5 joins, unsubscribed pack, unknown table, unknown column, un-indexed filter, `LIKE`, bogus join, `RIGHT JOIN`, unfiltered PII, `ORG_ID` inside `OR`, two statements, `SELECT *` on PII |
| Tenancy | The same query under two grants compiles to two different `ORG_ID`s |
| Grants | Payload tampering, wrong-secret re-signing, expiry, garbage and missing all refused; forged org rejected as `bad_signature` |
| Masking | Both Ashwins stay distinguishable while masked; aggregates and IPs untouched |
| Answer shapers | All eight escalation patterns produce correct summaries and customer-ready ticket comments; the 02:14 outlier is named, not averaged away |
| Rules routing | 15/15 questions route to the intended rule |
| Schema | 21 tables, 168 columns, 22 FKs; every boolean has a default, no reserved names, `ORG_ID` on all 21 |

**Not yet run:** the 21 live verification questions, which need the project.
