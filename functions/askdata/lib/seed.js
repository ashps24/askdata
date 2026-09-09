'use strict';

/**
 * Sample data.
 *
 * STAGED ON PURPOSE. Advanced I/O is hard-capped at 30 seconds and this writes
 * a few thousand rows, so `seed()` takes a stage name and does one slice per
 * call. Running it as one shot would time out at ~34s while the writes kept
 * landing, leaving a half-populated store that looks seeded.
 *
 * DETERMINISTIC. A fixed-seed PRNG, not Math.random. A generator that produces
 * plausible-but-random rows cannot demonstrate a correct answer: the
 * verification questions ask about *specific* facts, so those facts are written
 * explicitly and the filler is reproducible around them.
 *
 * The facts the questions depend on, all deliberate:
 *
 *   - lead 4551000000234017 in Northwind, source "Trade Show", never edited
 *   - lead 4551000000234021, source changed Web Form -> Referral, with history
 *   - exactly 5 Northwind leads with a NULL source ("why is it blank?")
 *   - Ashwin Prakash (U-1007): three small filtered exports, and one 4,000-row
 *     unfiltered Contacts export at 02:14 from 203.0.113.77
 *   - Ashwin Menon (U-1019): same first name, ordinary activity only. This
 *     collision is load-bearing - without it, rule 4 is untestable
 *   - Contoso's Meera Raman: profile "Marketing Executive" with
 *     campaigns.segments.create GRANTED = false
 *   - Fabrikam's Rahul Iyer: in Billing and Technical, NOT in Escalations
 */

const { flattenRows } = require('./replica');
const time = require('./time');

/* ------------------------------------------------------------------ prng */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

const B = (v) => (v ? 'true' : 'false');
const dt = (d) => time.istNaive(d);
// `ago()` already returns an IST naive string, so day() truncates rather than
// converting. Converting again would shift by 5:30 a second time.
const day = (v) => (typeof v === 'string' ? v.slice(0, 10) : time.istDay(v));
/**
 * `days` ago at a given IST wall-clock time, as a naive string.
 * The hour is set on the IST representation, not on UTC - otherwise the 02:14
 * export would be generated as 02:14 UTC and stored as 07:44 IST.
 */
const ago = (days, hour = null, min = 0) => time.daysAgoNaive(days, hour, min);

/* ------------------------------------------------------------------- orgs */

/**
 * The customer companies, and the per-service org ids support engineers are
 * actually given.
 *
 * A customer is one company but several org ids: a ticket about CRM quotes the
 * CRM org id, a ticket about Desk quotes the Desk portal id, and they are
 * different numbers. Support engineers copy whichever one is on the ticket in
 * front of them, so AskData has to accept any of them and resolve them to the
 * same company - while scoping the answer to the service that was named.
 *
 * The three original ZGIDs are preserved as CRM org ids (60021847312 and its
 * neighbours), so every entitlement, audit row and saved link still resolves.
 */
const COMPANY_SPECS = [
  ['ORG-NORTHWIND', 'Northwind Traders',    'in',  'Enterprise',   'crm,campaigns,desk', '2021-03-01', 100],
  ['ORG-CONTOSO',   'Contoso Ltd',          'com', 'Professional', 'crm,campaigns',      '2022-07-14', 40],
  ['ORG-FABRIKAM',  'Fabrikam Inc',         'eu',  'Enterprise',   'crm,desk',           '2020-11-02', 40],
  ['ORG-ZYLKER',    'Zylker Corp',          'in',  'Enterprise',   'crm,campaigns,desk', '2019-06-18', 90],
  ['ORG-ACME',      'Acme Retail Group',    'com', 'Enterprise',   'crm,desk',           '2021-09-30', 70],
  ['ORG-VERTEX',    'Vertex Financial',     'au',  'Professional', 'crm',                '2023-01-11', 50],
  ['ORG-HELIOS',    'Helios Manufacturing', 'jp',  'Enterprise',   'crm,campaigns,desk', '2018-04-05', 80],
  ['ORG-MERIDIAN',  'Meridian Healthcare',  'ca',  'Professional', 'crm,desk',           '2022-02-22', 45],
  ['ORG-SOLSTICE',  'Solstice Media',       'eu',  'Standard',     'crm,campaigns',      '2023-08-07', 35],
  ['ORG-IRONCLAD',  'Ironclad Logistics',   'uae', 'Enterprise',   'crm,campaigns,desk', '2020-01-20', 60],
];

/** Distinct number space per service, so an id says which service it belongs to. */
const SERVICE_PREFIX = { crm: '600218', campaigns: '700315', desk: '800427' };

const ORGS = COMPANY_SPECS.map(
  ([ORG_ID, ORG_NAME, DC, EDITION, SUBSCRIBED_PRODUCTS, SIGNED_UP_ON, leads], i) => {
    const tail = String(47312 + i);
    const products = SUBSCRIBED_PRODUCTS.split(',');
    const serviceOrgIds = {};
    for (const service of products) {
      if (SERVICE_PREFIX[service]) serviceOrgIds[service] = SERVICE_PREFIX[service] + tail;
    }
    return {
      ORG_ID, ORG_NAME, DC, EDITION, SUBSCRIBED_PRODUCTS, SIGNED_UP_ON,
      STATUS: 'active',
      // The CRM org id doubles as the company's ZGID, which is what every
      // entitlement and audit row was already written against.
      ZGID: SERVICE_PREFIX.crm + tail,
      CRM_ORG_ID: serviceOrgIds.crm ?? null,
      CMP_ORG_ID: serviceOrgIds.campaigns ?? null,
      DESK_ORG_ID: serviceOrgIds.desk ?? null,
      serviceOrgIds,
      index: i + 1,
      seed: 1001 + i * 1001,
      users: 12,
      leads,
    };
  }
);

/** service org id (any service) -> the company it belongs to. */
function orgByServiceId(serviceOrgId, service = null) {
  const wanted = String(serviceOrgId ?? '').trim();
  return ORGS.find((o) =>
    service
      ? o.serviceOrgIds[service] === wanted
      : Object.values(o.serviceOrgIds).includes(wanted) || o.ZGID === wanted) ?? null;
}

const ENGINEER = process.env.ASKDATA_DEMO_ENGINEER || 'ashwin.p@zohocorp.com';

/* -------------------------------------------------------- name generation */

const FIRST = ['Priya', 'Rahul', 'Meera', 'Arjun', 'Divya', 'Karthik', 'Sneha', 'Vikram',
  'Anita', 'Suresh', 'Lakshmi', 'Nikhil', 'Pooja', 'Ramesh', 'Kavya', 'Aditya',
  'Deepa', 'Manoj', 'Swathi', 'Harish', 'Nandini', 'Girish', 'Shalini'];
const LAST = ['Nair', 'Iyer', 'Raman', 'Menon', 'Sharma', 'Reddy', 'Gupta', 'Pillai',
  'Bose', 'Rao', 'Kulkarni', 'Desai', 'Joshi', 'Verma', 'Kapoor', 'Chandra',
  'Bhat', 'Krishnan', 'Shetty', 'Mathew', 'Prasad', 'Varma', 'Sundaram'];

const COMPANIES = ['Aster Logistics', 'Blue Ridge Foods', 'Cobalt Systems', 'Delta Print',
  'Everline Media', 'Fairmont Steel', 'Granite Health', 'Harbour Freight',
  'Indigo Analytics', 'Junction Retail', 'Keystone Legal', 'Lumen Energy',
  'Meridian Travel', 'Northgate Realty', 'Orbit Telecom', 'Pinnacle Build'];

const SOURCES = ['Web Form', 'Trade Show', 'Referral', 'Cold Call', 'Partner', 'Advertisement', 'Webinar'];
const STATUSES = ['New', 'Contacted', 'Qualified', 'Nurturing', 'Junk', 'Converted'];
const DEAL_STAGES = ['Qualification', 'Needs Analysis', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];
const INDUSTRIES = ['Logistics', 'Retail', 'Technology', 'Healthcare', 'Manufacturing', 'Media', 'Energy'];

function emailFor(name, org) {
  const domain = org.ORG_NAME.split(' ')[0].toLowerCase();
  return `${name.toLowerCase().replace(/\s+/g, '.')}@${domain}.example.com`;
}

/* ------------------------------------------------------------ permissions */

const PERMISSION_MATRIX = {
  crm: { Leads: ['view', 'create', 'edit', 'delete', 'export'], Contacts: ['view', 'create', 'edit', 'delete', 'export'], Accounts: ['view', 'create', 'edit', 'delete'], Deals: ['view', 'create', 'edit', 'delete', 'approve'] },
  campaigns: { Lists: ['view', 'create', 'edit', 'delete'], Segments: ['view', 'create', 'edit', 'delete'], Campaigns: ['view', 'create', 'edit', 'share'] },
  desk: { Tickets: ['view', 'create', 'edit', 'delete', 'share'], Departments: ['view', 'create', 'edit'] },
};

/** Six profiles per product, from most to least privileged. */
const PROFILE_SETS = {
  crm: ['Administrator', 'Sales Manager', 'Sales Executive', 'Marketing Executive', 'Support Read Only', 'Intern'],
  campaigns: ['Administrator', 'Campaign Manager', 'Marketing Executive', 'Content Editor', 'Analyst', 'Intern'],
  desk: ['Administrator', 'Support Manager', 'Senior Agent', 'Agent', 'Light Agent', 'Intern'],
};

/** How much of the catalog each profile rank gets. */
const RANK_ACTIONS = [
  ['view', 'create', 'edit', 'delete', 'export', 'share', 'approve'],
  ['view', 'create', 'edit', 'export', 'share', 'approve'],
  ['view', 'create', 'edit', 'export'],
  ['view', 'create', 'edit'],
  ['view'],
  ['view'],
];

/* ------------------------------------------------------------- generators */

function buildPlatform() {
  const out = {
    Orgs: [], SupportEntitlements: [], Users: [], Profiles: [], UserProfiles: [],
    Permissions: [], ProfilePermissions: [],
  };

  for (const org of ORGS) {
    const r = rng(org.seed);
    const products = org.SUBSCRIBED_PRODUCTS.split(',');

    out.Orgs.push({
      ORG_ID: org.ORG_ID, ZGID: org.ZGID, ORG_NAME: org.ORG_NAME, DC: org.DC,
      EDITION: org.EDITION, SUBSCRIBED_PRODUCTS: org.SUBSCRIBED_PRODUCTS,
      STATUS: org.STATUS, SIGNED_UP_ON: org.SIGNED_UP_ON,
      CRM_ORG_ID: org.CRM_ORG_ID, CMP_ORG_ID: org.CMP_ORG_ID, DESK_ORG_ID: org.DESK_ORG_ID,
    });

    // The engineer holds an open ticket for every org, plus one elevated grant
    // on Northwind so both entitlement paths are exercised.
    out.SupportEntitlements.push({
      ORG_ID: org.ORG_ID, ENTITLEMENT_ID: `E-${org.ZGID}-1`, ENGINEER_EMAIL: ENGINEER,
      ZGID: org.ZGID, TICKET_ID: `TKT-${org.ZGID.slice(-4)}`, KIND: 'open_ticket',
      TICKET_STATUS: 'open', VALID_FROM: ago(30), VALID_UNTIL: ago(-30),
    });
    // A closed ticket, to prove a closed one does NOT entitle.
    out.SupportEntitlements.push({
      ORG_ID: org.ORG_ID, ENTITLEMENT_ID: `E-${org.ZGID}-2`, ENGINEER_EMAIL: ENGINEER,
      ZGID: org.ZGID, TICKET_ID: `TKT-CLOSED-${org.ZGID.slice(-4)}`, KIND: 'open_ticket',
      TICKET_STATUS: 'closed', VALID_FROM: ago(60), VALID_UNTIL: ago(40),
    });
    if (org.ORG_ID === 'ORG-NORTHWIND') {
      out.SupportEntitlements.push({
        ORG_ID: org.ORG_ID, ENTITLEMENT_ID: `E-${org.ZGID}-3`, ENGINEER_EMAIL: ENGINEER,
        ZGID: org.ZGID, TICKET_ID: 'ANY', KIND: 'elevated_access',
        TICKET_STATUS: 'open', VALID_FROM: ago(1), VALID_UNTIL: ago(-2),
      });
    }

    /* -- users ------------------------------------------------------- */
    const prefix = org.index;
    const users = [];
    for (let i = 1; i <= org.users; i++) {
      const id = `U-${prefix}0${String(i).padStart(2, '0')}`;
      let name = `${FIRST[(i * 7) % FIRST.length]} ${LAST[(i * 5) % LAST.length]}`;

      // The two Ashwins. Same first name, different surname, same org - this
      // collision is what proves rule 4, and without it that path is untestable.
      if (org.ORG_ID === 'ORG-NORTHWIND' && i === 7) name = 'Ashwin Prakash';
      if (org.ORG_ID === 'ORG-NORTHWIND' && i === 19) name = 'Ashwin Menon';
      if (org.ORG_ID === 'ORG-CONTOSO' && i === 4) name = 'Meera Raman';
      if (org.ORG_ID === 'ORG-FABRIKAM' && i === 5) name = 'Rahul Iyer';

      // A spread of last logins so "who hasn't logged in for 30 days" has a
      // real answer rather than everyone or nobody.
      const lastLoginDays = i % 6 === 0 ? int(r, 35, 120) : int(r, 0, 20);
      const status = i % 12 === 0 ? 'inactive' : 'active';

      users.push({
        ORG_ID: org.ORG_ID, USER_ID: id, ZUID: `${6000000 + prefix * 10000 + i}`,
        FULL_NAME: name, EMAIL: emailFor(name, org), STATUS: status,
        LAST_LOGIN: ago(lastLoginDays, int(r, 8, 19), int(r, 0, 59)),
        CREATED_ON: day(ago(int(r, 200, 1200))),
      });
    }
    out.Users.push(...users);

    /* -- profiles, permissions, grants ------------------------------- */
    let pid = 0;
    const profilesByProduct = {};
    for (const product of products) {
      profilesByProduct[product] = [];
      for (const [rank, pname] of PROFILE_SETS[product].entries()) {
        pid++;
        const profileId = `P-${prefix}${String(pid).padStart(2, '0')}`;
        out.Profiles.push({
          ORG_ID: org.ORG_ID, PROFILE_ID: profileId, PRODUCT: product,
          PROFILE_NAME: pname, IS_CUSTOM: B(rank >= 3),
        });
        profilesByProduct[product].push({ profileId, pname, rank });
      }
    }

    let permId = 0;
    const permissions = [];
    for (const product of products) {
      for (const [module, actions] of Object.entries(PERMISSION_MATRIX[product])) {
        for (const action of actions) {
          permId++;
          const key = `${product}.${module.toLowerCase()}.${action}`;
          const p = {
            ORG_ID: org.ORG_ID, PERMISSION_ID: `PM-${prefix}${String(permId).padStart(3, '0')}`,
            PRODUCT: product, MODULE: module, ACTION: action, PERMISSION_KEY: key,
            DISPLAY_NAME: `${action[0].toUpperCase()}${action.slice(1)} ${module}`,
          };
          permissions.push(p);
          out.Permissions.push(p);
        }
      }
    }

    for (const product of products) {
      const prodPerms = permissions.filter((p) => p.PRODUCT === product);
      for (const { profileId, pname, rank } of profilesByProduct[product]) {
        for (const p of prodPerms) {
          let granted = RANK_ACTIONS[rank].includes(p.ACTION);

          // Contoso's Marketing Executive must NOT be able to create segments,
          // so the permission question resolves to a definite "no, and here's why".
          if (org.ORG_ID === 'ORG-CONTOSO' && pname === 'Marketing Executive' &&
              p.PERMISSION_KEY === 'campaigns.segments.create') {
            granted = false;
          }
          out.ProfilePermissions.push({
            ORG_ID: org.ORG_ID, PROFILE_ID: profileId, PERMISSION_ID: p.PERMISSION_ID,
            GRANTED: B(granted),
          });
        }
      }
    }

    /* -- which profile each user holds, per product ------------------ */
    for (const [i, u] of users.entries()) {
      for (const product of products) {
        const set = profilesByProduct[product];
        let chosen = set[Math.min(set.length - 1, 1 + (i % (set.length - 1)))];
        if (i === 0) chosen = set[0];                       // an administrator
        if (u.FULL_NAME === 'Meera Raman' && product === 'campaigns') {
          chosen = set.find((s) => s.pname === 'Marketing Executive') ?? chosen;
        }
        if (u.FULL_NAME === 'Ashwin Prakash' && product === 'crm') {
          chosen = set.find((s) => s.pname === 'Sales Executive') ?? chosen;
        }
        out.UserProfiles.push({
          ORG_ID: org.ORG_ID, USER_ID: u.USER_ID, PRODUCT: product,
          PROFILE_ID: chosen.profileId, ASSIGNED_ON: day(ago(int(r, 30, 700))),
        });
      }
    }
  }

  return out;
}

function buildCrm() {
  const out = {
    CRM_Accounts: [], CRM_Contacts: [], CRM_Leads: [], CRM_Deals: [],
    CRM_ExportJobs: [], CRM_FieldHistory: [],
  };

  for (const org of ORGS) {
    const r = rng(org.seed + 11);
    const prefix = org.index;
    const uid = (n) => `U-${prefix}0${String(n).padStart(2, '0')}`;

    /* -- accounts. The org's own name is included so "contacts at
          <customer>" resolves to a real account rather than a whole-table
          dump the guard would (correctly) refuse. -------------------- */
    const accountNames = [org.ORG_NAME, ...COMPANIES.slice(0, 11)];

    // Built into a LOCAL array, then appended. `out.CRM_Accounts` accumulates
    // across orgs, so indexing it directly handed the second and third orgs'
    // contacts and deals the FIRST org's ACCOUNT_IDs - a cross-tenant smear
    // that the ref backfill then reported as 70 unresolved rows.
    const accounts = accountNames.map((name, i) => ({
      ORG_ID: org.ORG_ID, ACCOUNT_ID: `A-${prefix}${String(i + 1).padStart(3, '0')}`,
      ACCOUNT_NAME: name, INDUSTRY: pick(r, INDUSTRIES),
      OWNER_ID: uid(int(r, 1, org.users)), CREATED_ON: ago(int(r, 100, 900)),
    }));
    out.CRM_Accounts.push(...accounts);

    /* -- contacts ---------------------------------------------------- */
    for (let i = 1; i <= (org.ORG_ID === 'ORG-NORTHWIND' ? 40 : 20); i++) {
      const name = `${FIRST[(i * 3) % FIRST.length]} ${LAST[(i * 11) % LAST.length]}`;
      const acct = accounts[i % accounts.length];
      out.CRM_Contacts.push({
        ORG_ID: org.ORG_ID, CONTACT_ID: `C-${prefix}${String(i).padStart(3, '0')}`,
        ACCOUNT_ID: acct.ACCOUNT_ID, FULL_NAME: name,
        EMAIL: `${name.toLowerCase().replace(/\s+/g, '.')}@${acct.ACCOUNT_NAME.split(' ')[0].toLowerCase()}.example.com`,
        PHONE: `+91 9${int(r, 1000, 9999)} ${int(r, 10000, 99999)}`,
        TITLE: pick(r, ['Director', 'Manager', 'Head of Ops', 'Analyst', 'VP', 'Consultant']),
        OWNER_ID: uid(int(r, 1, org.users)), CREATED_ON: ago(int(r, 20, 700)),
      });
    }

    /* -- leads ------------------------------------------------------- */
    //
    // Northwind gets exactly 100, with exactly 5 NULL sources and a handful of
    // 'Import' rows - "why is the source blank?" is itself a common ticket, and
    // the count has to be exact for the verification to mean anything.
    const nullSourceIndexes = new Set([13, 27, 44, 68, 91]);
    for (let i = 1; i <= org.leads; i++) {
      const leadId = String(4551000000234000 + prefix * 1000 + i);
      let source = pick(r, SOURCES);
      if (i % 17 === 0) source = 'Import';
      if (org.ORG_ID === 'ORG-NORTHWIND' && nullSourceIndexes.has(i)) source = null;
      else if (org.ORG_ID !== 'ORG-NORTHWIND' && i % 19 === 0) source = null;

      const created = ago(int(r, 5, 240), int(r, 8, 20), int(r, 0, 59));
      let modified = created;
      // A few rows edited minutes ago, so replica-lag realism has something
      // to bite on.
      if (i % 23 === 0) modified = new Date(Date.now() - int(r, 1, 9) * 60000);

      const row = {
        ORG_ID: org.ORG_ID, LEAD_ID: leadId,
        FULL_NAME: `${FIRST[(i * 13) % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
        EMAIL: `lead${i}@${COMPANIES[i % COMPANIES.length].split(' ')[0].toLowerCase()}.example.com`,
        PHONE: `+91 9${int(r, 1000, 9999)} ${int(r, 10000, 99999)}`,
        COMPANY: COMPANIES[i % COMPANIES.length],
        LEAD_SOURCE: source, LEAD_STATUS: pick(r, STATUSES),
        OWNER_ID: uid(int(r, 1, org.users)),
        CONVERTED: B(i % 9 === 0), CONVERTED_ON: i % 9 === 0 ? day(created) : null,
        CREATED_ON: dt(created), MODIFIED_ON: dt(modified),
      };

      // The walkthrough lead: a known id with an unambiguous source, never
      // edited, so "no change since creation" is a true statement.
      if (org.ORG_ID === 'ORG-NORTHWIND' && i === 17) {
        row.LEAD_ID = '4551000000234017';
        row.LEAD_SOURCE = 'Trade Show';
        row.COMPANY = 'Harbour Freight';
        row.LEAD_STATUS = 'Qualified';
        row.CREATED_ON = '2026-08-12 10:22:00';
        row.MODIFIED_ON = row.CREATED_ON;
      }
      // The one with a history: source was changed after creation.
      if (org.ORG_ID === 'ORG-NORTHWIND' && i === 21) {
        row.LEAD_ID = '4551000000234021';
        row.LEAD_SOURCE = 'Referral';
        row.COMPANY = 'Indigo Analytics';
        row.CREATED_ON = '2026-08-02 09:15:00';
        row.MODIFIED_ON = '2026-09-04 16:20:00';
      }
      out.CRM_Leads.push(row);
    }

    /* -- deals ------------------------------------------------------- */
    for (let i = 1; i <= (org.ORG_ID === 'ORG-NORTHWIND' ? 30 : 15); i++) {
      const acct = accounts[i % accounts.length];
      out.CRM_Deals.push({
        ORG_ID: org.ORG_ID, DEAL_ID: `D-${prefix}${String(i).padStart(3, '0')}`,
        DEAL_NAME: `${acct.ACCOUNT_NAME} - ${pick(r, ['Renewal', 'Expansion', 'New Licence', 'Upgrade'])}`,
        ACCOUNT_ID: acct.ACCOUNT_ID, STAGE: pick(r, DEAL_STAGES),
        AMOUNT: int(r, 40, 900) * 1000,
        CLOSING_DATE: day(ago(-int(r, 5, 120))),
        OWNER_ID: uid(int(r, 1, org.users)), CREATED_ON: ago(int(r, 10, 300)),
      });
    }

    /* -- export jobs -------------------------------------------------- */
    //
    // Northwind's Ashwin Prakash (U-1007) is the security question. Three small
    // filtered exports, and one that is materially different. Without a real
    // signal in the data the demo proves nothing.
    if (org.ORG_ID === 'ORG-NORTHWIND') {
      const ap = 'U-1007';
      out.CRM_ExportJobs.push(
        { ORG_ID: org.ORG_ID, EXPORT_ID: 'X-1001', USER_ID: ap, MODULE: 'Leads', FORMAT: 'csv', ROW_COUNT: 48, FILTER_APPLIED: 'Lead Status = Qualified', IP_ADDRESS: '10.14.2.8', STATUS: 'completed', EXPORTED_AT: ago(20, 15, 31) },
        { ORG_ID: org.ORG_ID, EXPORT_ID: 'X-1002', USER_ID: ap, MODULE: 'Deals', FORMAT: 'xls', ROW_COUNT: 12, FILTER_APPLIED: 'Stage = Proposal', IP_ADDRESS: '10.14.2.8', STATUS: 'completed', EXPORTED_AT: ago(29, 11, 5) },
        { ORG_ID: org.ORG_ID, EXPORT_ID: 'X-1003', USER_ID: ap, MODULE: 'Leads', FORMAT: 'csv', ROW_COUNT: 30, FILTER_APPLIED: 'Owner = me', IP_ADDRESS: '10.14.2.8', STATUS: 'completed', EXPORTED_AT: ago(43, 17, 44) },
        { ORG_ID: org.ORG_ID, EXPORT_ID: 'X-1004', USER_ID: ap, MODULE: 'Contacts', FORMAT: 'csv', ROW_COUNT: 4000, FILTER_APPLIED: null, IP_ADDRESS: '203.0.113.77', STATUS: 'completed', EXPORTED_AT: ago(7, 2, 14) },
        // Ashwin Menon: ordinary activity only.
        { ORG_ID: org.ORG_ID, EXPORT_ID: 'X-1005', USER_ID: 'U-1019', MODULE: 'Leads', FORMAT: 'csv', ROW_COUNT: 22, FILTER_APPLIED: 'Created this month', IP_ADDRESS: '10.14.2.31', STATUS: 'completed', EXPORTED_AT: ago(12, 10, 2) },
      );
    }
    const startIdx = out.CRM_ExportJobs.filter((e) => e.ORG_ID === org.ORG_ID).length;
    for (let i = startIdx + 1; i <= 10; i++) {
      out.CRM_ExportJobs.push({
        ORG_ID: org.ORG_ID, EXPORT_ID: `X-${prefix}${String(i).padStart(3, '0')}`,
        USER_ID: uid(int(r, 1, org.users)), MODULE: pick(r, ['Leads', 'Contacts', 'Deals', 'Accounts']),
        FORMAT: pick(r, ['csv', 'xls']), ROW_COUNT: int(r, 5, 220),
        FILTER_APPLIED: pick(r, ['Owner = me', 'Created this month', 'Stage = Proposal', 'Status = Active']),
        IP_ADDRESS: `10.${int(r, 10, 40)}.${int(r, 1, 250)}.${int(r, 1, 250)}`,
        STATUS: 'completed', EXPORTED_AT: ago(int(r, 1, 88), int(r, 9, 18), int(r, 0, 59)),
      });
    }

    /* -- field history ------------------------------------------------ */
    if (org.ORG_ID === 'ORG-NORTHWIND') {
      out.CRM_FieldHistory.push(
        { ORG_ID: org.ORG_ID, HISTORY_ID: 'H-1001', MODULE: 'Leads', RECORD_ID: '4551000000234021', FIELD_NAME: 'LEAD_SOURCE', OLD_VALUE: 'Web Form', NEW_VALUE: 'Referral', CHANGED_BY: 'U-1004', CHANGED_AT: '2026-09-04 16:20:00' },
        { ORG_ID: org.ORG_ID, HISTORY_ID: 'H-1002', MODULE: 'Leads', RECORD_ID: '4551000000234021', FIELD_NAME: 'LEAD_STATUS', OLD_VALUE: 'New', NEW_VALUE: 'Contacted', CHANGED_BY: 'U-1004', CHANGED_AT: '2026-08-30 11:02:00' },
      );
    }
    for (let i = 1; i <= 8; i++) {
      const lead = out.CRM_Leads.filter((l) => l.ORG_ID === org.ORG_ID)[i * 3];
      if (!lead) continue;
      out.CRM_FieldHistory.push({
        ORG_ID: org.ORG_ID, HISTORY_ID: `H-${prefix}${String(100 + i)}`, MODULE: 'Leads',
        RECORD_ID: lead.LEAD_ID, FIELD_NAME: pick(r, ['LEAD_STATUS', 'OWNER_ID']),
        OLD_VALUE: pick(r, STATUSES), NEW_VALUE: pick(r, STATUSES),
        CHANGED_BY: uid(int(r, 1, org.users)), CHANGED_AT: ago(int(r, 2, 60), int(r, 9, 18), 0),
      });
    }
  }

  return out;
}

function buildCampaigns() {
  const out = { CMP_Lists: [], CMP_Segments: [], CMP_Campaigns: [] };
  for (const org of ORGS) {
    if (!org.SUBSCRIBED_PRODUCTS.includes('campaigns')) continue;
    const r = rng(org.seed + 22);
    const prefix = org.ORG_ID === 'ORG-NORTHWIND' ? 1 : 2;
    const uid = (n) => `U-${prefix}0${String(n).padStart(2, '0')}`;

    for (let i = 1; i <= 6; i++) {
      out.CMP_Lists.push({
        ORG_ID: org.ORG_ID, LIST_ID: `L-${prefix}${String(i).padStart(2, '0')}`,
        LIST_NAME: pick(r, ['Newsletter Subscribers', 'Trade Show Leads', 'Existing Customers',
          'Webinar Registrants', 'Partner Contacts', 'Dormant Accounts']) + ` ${i}`,
        CONTACT_COUNT: int(r, 200, 9000), OWNER_ID: uid(int(r, 1, 20)),
        CREATED_ON: ago(int(r, 30, 500)),
      });
    }
    for (let i = 1; i <= 8; i++) {
      const l = out.CMP_Lists.filter((x) => x.ORG_ID === org.ORG_ID)[i % 6];
      out.CMP_Segments.push({
        ORG_ID: org.ORG_ID, SEGMENT_ID: `S-${prefix}${String(i).padStart(2, '0')}`,
        LIST_ID: l.LIST_ID, SEGMENT_NAME: `${['Opened last 30d', 'Never opened', 'Clicked twice', 'India only', 'Enterprise only', 'Bounced', 'High intent', 'Cold'][i - 1]}`,
        CRITERIA: pick(r, ['opens > 0', 'opens = 0', 'clicks >= 2', 'country = IN', 'employees > 500', 'bounced = true']),
        CREATED_BY: uid(int(r, 1, 20)), CREATED_ON: ago(int(r, 10, 300)),
      });
    }
    for (let i = 1; i <= 10; i++) {
      const l = out.CMP_Lists.filter((x) => x.ORG_ID === org.ORG_ID)[i % 6];
      out.CMP_Campaigns.push({
        ORG_ID: org.ORG_ID, CAMPAIGN_ID: `CM-${prefix}${String(i).padStart(2, '0')}`,
        CAMPAIGN_NAME: `${['Spring Offer', 'Product Update', 'Webinar Invite', 'Renewal Reminder', 'Case Study', 'Feature Launch', 'Survey', 'Newsletter', 'Re-engagement', 'Event Invite'][i - 1]} ${2026}`,
        LIST_ID: l.LIST_ID, STATUS: i > 8 ? 'draft' : 'sent',
        SENT_COUNT: i > 8 ? 0 : int(r, 150, 8000),
        OPEN_RATE: i > 8 ? 0 : Number((r() * 45 + 8).toFixed(2)),
        SENT_ON: i > 8 ? null : ago(int(r, 3, 200)),
        CREATED_BY: uid(int(r, 1, 20)),
      });
    }
  }
  return out;
}

function buildDesk() {
  const out = { DESK_Departments: [], DESK_DepartmentMembers: [], DESK_Tickets: [] };
  for (const org of ORGS) {
    if (!org.SUBSCRIBED_PRODUCTS.includes('desk')) continue;
    const r = rng(org.seed + 33);
    const prefix = org.ORG_ID === 'ORG-NORTHWIND' ? 1 : 3;
    const uid = (n) => `U-${prefix}0${String(n).padStart(2, '0')}`;

    const names = ['General', 'Billing', 'Technical', 'Escalations', 'Onboarding'];
    for (const [i, name] of names.entries()) {
      out.DESK_Departments.push({
        ORG_ID: org.ORG_ID, DEPARTMENT_ID: `DP-${prefix}${String(i + 1).padStart(2, '0')}`,
        DEPARTMENT_NAME: name, IS_DEFAULT: B(i === 0), CREATED_ON: ago(int(r, 300, 900)),
      });
    }
    const deptOf = (n) => out.DESK_Departments.find((d) => d.ORG_ID === org.ORG_ID && d.DEPARTMENT_NAME === n);

    let mid = 0;
    const addMember = (userId, deptName, role) => {
      mid++;
      out.DESK_DepartmentMembers.push({
        ORG_ID: org.ORG_ID, MEMBER_ID: `M-${prefix}${String(mid).padStart(3, '0')}`,
        DEPARTMENT_ID: deptOf(deptName).DEPARTMENT_ID, USER_ID: userId,
        ROLE_IN_DEPT: role, ADDED_ON: day(ago(int(r, 20, 500))),
      });
    };

    // Fabrikam's Rahul Iyer (U-3005): in Billing and Technical, deliberately
    // NOT in Escalations - so the Desk question has a precise answer instead of
    // an empty result.
    if (org.ORG_ID === 'ORG-FABRIKAM') {
      addMember('U-3005', 'Billing', 'agent');
      addMember('U-3005', 'Technical', 'lead');
    }
    for (let i = 1; i <= 18; i++) {
      const u = uid(i);
      if (u === 'U-3005') continue;
      addMember(u, names[i % names.length], pick(r, ['agent', 'agent', 'lead', 'manager']));
    }

    for (let i = 1; i <= 24; i++) {
      const d = out.DESK_Departments.filter((x) => x.ORG_ID === org.ORG_ID)[i % names.length];
      out.DESK_Tickets.push({
        ORG_ID: org.ORG_ID, TICKET_ID: `T-${prefix}${String(i).padStart(3, '0')}`,
        DEPARTMENT_ID: d.DEPARTMENT_ID,
        SUBJECT: pick(r, ['Cannot log in after password reset', 'Invoice shows wrong tax',
          'Export fails midway', 'Permission denied on delete', 'Slow dashboard',
          'Duplicate records created', 'Email not delivered', 'API returns 401']),
        STATUS: i % 4 === 0 ? 'Closed' : pick(r, ['Open', 'On Hold', 'Escalated']),
        TICKET_PRIORITY: pick(r, ['Low', 'Medium', 'High', 'Urgent']),
        ASSIGNEE_ID: uid(int(r, 1, 18)),
        CONTACT_EMAIL: `customer${i}@${COMPANIES[i % COMPANIES.length].split(' ')[0].toLowerCase()}.example.com`,
        CREATED_ON: ago(int(r, 1, 120), int(r, 8, 19), int(r, 0, 59)),
      });
    }
  }
  return out;
}

/**
 * Events per org. The design asks for 400+; it is adjustable so a re-seed can
 * fit a reduced write allowance, at the cost of a thinner audit trail. Changing
 * it is a deliberate trade-off, not a default.
 */
const AUDIT_PER_ORG = { value: 420 };

function buildAudit() {
  const out = { AuditEvents: [] };
  const TYPES = ['login', 'logout', 'export', 'record_view', 'record_edit', 'record_delete', 'permission_change', 'api_call'];

  for (const org of ORGS) {
    const r = rng(org.seed + 44);
    const prefix = org.index;
    const uid = (n) => `U-${prefix}0${String(n).padStart(2, '0')}`;
    const products = org.SUBSCRIBED_PRODUCTS.split(',');

    for (let i = 1; i <= AUDIT_PER_ORG.value; i++) {
      const type = pick(r, TYPES);
      const product = pick(r, products);
      out.AuditEvents.push({
        ORG_ID: org.ORG_ID, EVENT_ID: `EV-${prefix}${String(i).padStart(4, '0')}`,
        PRODUCT: product, USER_ID: uid(int(r, 1, org.users)), EVENT_TYPE: type,
        MODULE: pick(r, product === 'crm' ? ['Leads', 'Contacts', 'Deals', 'Accounts']
          : product === 'campaigns' ? ['Lists', 'Segments', 'Campaigns'] : ['Tickets', 'Departments']),
        RECORD_ID: String(4551000000234000 + int(r, 1, 400)),
        DETAILS: type === 'permission_change' ? 'profile permission toggled'
          : type === 'export' ? `exported ${int(r, 5, 500)} rows` : '',
        IP_ADDRESS: `10.${int(r, 10, 40)}.${int(r, 1, 250)}.${int(r, 1, 250)}`,
        OCCURRED_AT: ago(int(r, 0, 90), int(r, 0, 23), int(r, 0, 59)),
      });
    }

    // The 02:14 export appears in the unified trail too, so the two tables
    // corroborate each other rather than telling different stories.
    if (org.ORG_ID === 'ORG-NORTHWIND') {
      out.AuditEvents.push({
        ORG_ID: org.ORG_ID, EVENT_ID: 'EV-1-SPECIAL', PRODUCT: 'crm', USER_ID: 'U-1007',
        EVENT_TYPE: 'export', MODULE: 'Contacts', RECORD_ID: '',
        DETAILS: 'exported 4000 rows, no filter', IP_ADDRESS: '203.0.113.77',
        OCCURRED_AT: ago(7, 2, 14),
      });
    }
  }
  return out;
}

/* --------------------------------------------------------------- writing */

const STAGES = {
  platform: buildPlatform,
  crm: buildCrm,
  campaigns: buildCampaigns,
  desk: buildDesk,
  audit: buildAudit,
};

const BATCH = 200;

/** Delete everything for a table, so a re-seed is not additive. */
async function wipeTable(catalystApp, table) {
  for (const org of ORGS) {
    try {
      await catalystApp.zcql().executeZCQLQuery(
        `DELETE FROM ${table} WHERE ORG_ID = '${org.ORG_ID}'`
      );
    } catch (err) {
      // An empty table, or one that does not exist yet, is not a failure.
      if (!/no rows|not found|Unkown|Unknown/i.test(String(err.message))) {
        console.warn(`wipe ${table} for ${org.ORG_ID}: ${err.message}`);
      }
    }
  }
}

async function insertAll(catalystApp, table, rows) {
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((row) =>
      Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined)));
    await catalystApp.datastore().table(table).insertRows(batch);
    written += batch.length;
  }
  return written;
}

/**
 * Seed one stage. `only` is a stage name; omitted means all of them, which will
 * usually exceed the 30-second budget - call it per stage.
 */
/**
 * Can we still write? One row, then removed.
 *
 * This exists because of a real incident: the insert allowance ran out midway
 * through a re-seed, and since each table is WIPED before it is refilled, four
 * stages ended up empty rather than merely stale. Losing good data to a quota
 * error is a far worse outcome than refusing to start, so capacity is checked
 * before anything is deleted.
 */
async function canWrite(catalystApp) {
  const table = catalystApp.datastore().table('SupportQueryLog');
  try {
    const row = await table.insertRow({
      ORG_ID: '__probe__', LOG_ID: `probe-${Date.now()}`, OUTCOME: 'error',
      QUESTION: '[seed capacity probe]', GUARD_VERDICT: 'probe', ROW_COUNT: 0, LATENCY_MS: 0,
      OCCURRED_AT: time.istNaive(),
    });
    try { await table.deleteRow(row.ROWID); } catch { /* the probe row is harmless */ }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function seed(catalystApp, { only = null, wipe = true, auditPerOrg = null } = {}) {
  const stages = only ? [only] : Object.keys(STAGES);
  const written = {};

  if (wipe) {
    const probe = await canWrite(catalystApp);
    if (!probe.ok) {
      throw new Error(
        `Refusing to seed: writes are not currently possible, and seeding wipes ` +
        `before it inserts - starting would empty the tables. Underlying error: ${probe.error}`
      );
    }
  }

  if (auditPerOrg) AUDIT_PER_ORG.value = Math.max(1, Math.min(2000, Number(auditPerOrg)));

  for (const name of stages) {
    const builder = STAGES[name];
    if (!builder) throw new Error(`Unknown stage "${name}". Try: ${Object.keys(STAGES).join(', ')}`);

    const data = builder();
    for (const [table, rows] of Object.entries(data)) {
      if (wipe) await wipeTable(catalystApp, table);
      written[table] = await insertAll(catalystApp, table, rows);
    }
  }

  return { stages, written, total: Object.values(written).reduce((a, b) => a + b, 0) };
}

/* --------------------------------------------------------- ref backfill */

/**
 * Fill the `_REF` foreign keys.
 *
 * They hold the parent's ROWID, which the platform assigns at insert time, so
 * they cannot live in the fixture - only be resolved afterwards. Idempotent and
 * never deletes: re-running it after adding rows is the normal way to make
 * those rows joinable.
 */
async function backfillRefs(catalystApp) {
  const packs = require('./packs');
  const datastore = catalystApp.datastore();

  const links = [];
  for (const t of packs.ALL_TABLES) {
    for (const r of t.refs) links.push({ table: t.name, ...r });
  }

  const parentTables = [...new Set(links.map((l) => l.parent))];
  const childTables = [...new Set(links.map((l) => l.table))];

  const rowsOf = async (table) => {
    const all = [];
    let nextToken;
    for (;;) {
      const page = await datastore.table(table).getPagedRows({ nextToken, maxRows: 200 });
      all.push(...(page.data ?? []));
      if (!page.more_records) break;
      nextToken = page.next_token;
    }
    return all;
  };

  const cache = {};
  for (const t of [...new Set([...parentTables, ...childTables])]) cache[t] = await rowsOf(t);

  // (ORG_ID, business key) -> ROWID, per parent table and key column.
  const index = {};
  for (const l of links) {
    const key = `${l.parent}|${l.from}`;
    if (index[key]) continue;
    const parentDef = packs.ALL_TABLES.find((t) => t.name === l.parent);
    // The parent's own business key is the column matching the child's `from`,
    // or the parent's *_ID column when the names differ (OWNER_ID -> USER_ID).
    const candidates = [l.from, `${l.parent.replace(/^.*_/, '').toUpperCase().replace(/S$/, '')}_ID`, 'USER_ID',
      'ACCOUNT_ID', 'PROFILE_ID', 'PERMISSION_ID', 'DEPARTMENT_ID', 'LIST_ID'];
    const col = candidates.find((c) => parentDef?.columnNames.includes(c));
    const map = new Map();
    for (const row of cache[l.parent] ?? []) {
      if (col && row[col] !== undefined && row[col] !== null) map.set(`${row.ORG_ID} ${row[col]}`, row.ROWID);
    }
    index[key] = { map, col };
  }

  const report = [];
  const pending = new Map();

  for (const l of links) {
    const { map, col } = index[`${l.parent}|${l.from}`];
    let linked = 0; let already = 0; let unresolved = 0;

    for (const row of cache[l.table] ?? []) {
      const business = row[l.from];
      if (business === undefined || business === null || business === '') continue;
      const parentRowId = map.get(`${row.ORG_ID} ${business}`);
      if (!parentRowId) { unresolved++; continue; }
      if (String(row[l.column] ?? '') === String(parentRowId)) { already++; continue; }

      if (!pending.has(l.table)) pending.set(l.table, new Map());
      const forTable = pending.get(l.table);
      const patch = forTable.get(row.ROWID) ?? { ROWID: row.ROWID };
      patch[l.column] = parentRowId;
      forTable.set(row.ROWID, patch);
      linked++;
    }
    report.push({ table: l.table, ref: l.column, parent: `${l.parent}.${col}`, linked, already, unresolved });
  }

  const wrote = {};
  for (const [table, patches] of pending) {
    const all = [...patches.values()];
    wrote[table] = 0;
    for (let i = 0; i < all.length; i += BATCH) {
      await datastore.table(table).updateRows(all.slice(i, i + BATCH));
      wrote[table] += Math.min(BATCH, all.length - i);
    }
  }

  return {
    rowsRead: Object.fromEntries(Object.entries(cache).map(([t, r]) => [t, r.length])),
    links: report,
    rowsWritten: wrote,
  };
}

module.exports = { seed, backfillRefs, canWrite, AUDIT_PER_ORG, STAGES, ORGS, ENGINEER,
  orgByServiceId, SERVICE_PREFIX, buildPlatform, buildCrm, buildCampaigns, buildDesk, buildAudit };
