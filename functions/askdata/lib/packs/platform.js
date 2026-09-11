'use strict';

/**
 * Platform pack - product-agnostic tables, always loaded.
 *
 * These carry the customer's identity, its people, and the permission model
 * that every product hangs off. A pack for a specific product declares only
 * what is unique to it and joins back to `Users` here.
 *
 * `Orgs`, `SupportQueryLog` and `SupportEntitlements` are AskData's own
 * infrastructure rather than customer data, so they are marked `internal` and
 * kept out of the query allow-list: a generated query must never be able to
 * read the customer registry, the audit trail, or the entitlement table. The
 * server reads them directly.
 */

module.exports = {
  key: 'platform',
  label: 'Platform',
  always: true,

  synonyms: {
    'user': ['employee', 'staff', 'agent', 'person', 'member', 'rep', 'seat'],
    'profile': ['role', 'permission set', 'permission profile', 'access level'],
    'permission': ['privilege', 'right', 'access', 'grant', 'capability'],
    'last login': ['last signed in', 'last seen', 'last active', 'dormant', 'inactive'],
    'export': ['download', 'extract', 'pull out', 'exfiltrate', 'took data'],
    'audit': ['activity', 'history', 'trail', 'what did they do', 'logs'],
  },

  tables: [
    {
      name: 'Orgs',
      internal: true,
      label: 'customer organizations',
      describes: 'One row per customer org. AskData resolves a ZGID to an ORG_ID and a DC here.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'ZGID', type: 'varchar', max_length: 32, indexed: true, describe: 'The id support engineers type' },
        { name: 'ORG_NAME', type: 'varchar', max_length: 160 },
        { name: 'DC', type: 'varchar', max_length: 8, values: ['in', 'com', 'eu', 'au', 'jp', 'ca', 'sa', 'uae'] },
        { name: 'EDITION', type: 'varchar', max_length: 40 },
        { name: 'SUBSCRIBED_PRODUCTS', type: 'varchar', max_length: 200, describe: 'Comma separated pack keys' },
        // One company, several org ids. A CRM ticket quotes the CRM org id and a
        // Desk ticket quotes the Desk portal id; both have to resolve here.
        { name: 'CRM_ORG_ID', type: 'varchar', max_length: 32, indexed: true, describe: 'Org id on a CRM ticket' },
        { name: 'CMP_ORG_ID', type: 'varchar', max_length: 32, indexed: true, describe: 'Org id on a Campaigns ticket' },
        { name: 'DESK_ORG_ID', type: 'varchar', max_length: 32, indexed: true, describe: 'Portal id on a Desk ticket' },
        { name: 'STATUS', type: 'varchar', max_length: 20, values: ['active', 'trial', 'suspended'] },
        { name: 'SIGNED_UP_ON', type: 'date' },
      ],
    },

    {
      name: 'SupportEntitlements',
      internal: true,
      label: 'why an engineer may enter an org',
      describes:
        'What entitles a support engineer to one org right now. In production this ' +
        'is a view over the ticketing system and the elevated-access grants; here it ' +
        'is a table the connect check reads.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'ENTITLEMENT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'ENGINEER_EMAIL', type: 'varchar', max_length: 200, indexed: true },
        { name: 'ZGID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'TICKET_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'KIND', type: 'varchar', max_length: 24, values: ['open_ticket', 'elevated_access'] },
        { name: 'TICKET_STATUS', type: 'varchar', max_length: 20, values: ['open', 'closed'] },
        { name: 'VALID_FROM', type: 'datetime' },
        { name: 'VALID_UNTIL', type: 'datetime' },
      ],
    },

    {
      name: 'SupportQueryLog',
      internal: true,
      label: "AskData's own audit trail",
      describes: 'Every /ask, including the refusals and the errors.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'LOG_ID', type: 'varchar', max_length: 40, indexed: true },
        { name: 'ENGINEER_ID', type: 'varchar', max_length: 64 },
        { name: 'ENGINEER_EMAIL', type: 'varchar', max_length: 200 },
        { name: 'TICKET_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'ZGID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'QUESTION', type: 'varchar', max_length: 255 },
        { name: 'GENERATED_ZCQL', type: 'text' },
        { name: 'GUARD_VERDICT', type: 'varchar', max_length: 200 },
        { name: 'ROW_COUNT', type: 'int' },
        { name: 'LATENCY_MS', type: 'int' },
        { name: 'OUTCOME', type: 'varchar', max_length: 20, values: ['answered', 'refused', 'clarify', 'error'] },
        { name: 'PII_REVEALED', type: 'varchar', max_length: 200 },
        { name: 'OCCURRED_AT', type: 'datetime' },
      ],
    },

    {
      name: 'Users',
      label: 'people in the customer org',
      describes:
        'A person in the customer organization, across all products. The centre of ' +
        'the schema - most permission and activity questions start or end here.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'USER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'ZUID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'FULL_NAME', type: 'varchar', max_length: 160, pii: 'name', indexed: true },
        { name: 'EMAIL', type: 'varchar', max_length: 200, pii: 'email', indexed: true },
        { name: 'STATUS', type: 'varchar', max_length: 20, indexed: true, values: ['active', 'inactive', 'deleted'] },
        { name: 'LAST_LOGIN', type: 'datetime', indexed: true },
        { name: 'CREATED_ON', type: 'date' },
      ],
    },

    {
      name: 'Profiles',
      listable: true,
      label: 'permission profiles',
      describes: 'A permission profile, scoped to one product. A user holds one per product.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'PROFILE_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'PRODUCT', type: 'varchar', values: ['crm', 'campaigns', 'desk'], max_length: 24, indexed: true },
        { name: 'PROFILE_NAME', type: 'varchar', max_length: 80, indexed: true },
        { name: 'IS_CUSTOM', type: 'boolean', default_value: 'false' },
      ],
    },

    {
      name: 'UserProfiles',
      label: 'which profile a user holds per product',
      describes:
        'A user has a DIFFERENT profile in each product. This is the join that answers ' +
        'most permission questions, and ignoring PRODUCT here is the most common way to ' +
        "give a customer a confidently wrong answer about someone's access.",
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'USER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'PRODUCT', type: 'varchar', values: ['crm', 'campaigns', 'desk'], max_length: 24, indexed: true },
        { name: 'PROFILE_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'ASSIGNED_ON', type: 'date' },
      ],
      refs: [
        { column: 'USER_REF', parent: 'Users', from: 'USER_ID', onDelete: 'ON-DELETE-CASCADE' },
        { column: 'PROFILE_REF', parent: 'Profiles', from: 'PROFILE_ID', onDelete: 'ON-DELETE-CASCADE' },
      ],
    },

    {
      name: 'Permissions',
      listable: true,
      label: 'the catalog of grantable permissions',
      describes: 'What can be granted, per product and module. Not attached to anyone by itself.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'PERMISSION_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'PRODUCT', type: 'varchar', values: ['crm', 'campaigns', 'desk'], max_length: 24, indexed: true },
        { name: 'MODULE', type: 'varchar', max_length: 60, indexed: true },
        {
          name: 'ACTION', type: 'varchar', max_length: 20, indexed: true,
          values: ['view', 'create', 'edit', 'delete', 'export', 'share', 'approve'],
        },
        { name: 'PERMISSION_KEY', type: 'varchar', max_length: 120, indexed: true, describe: 'product.module.action' },
        { name: 'DISPLAY_NAME', type: 'varchar', max_length: 160 },
      ],
    },

    {
      name: 'ProfilePermissions',
      label: 'the grants',
      describes:
        'Whether a profile is granted a permission. GRANTED false is an explicit denial, ' +
        'not an absence - which is exactly what a "why can this user not do X" ticket needs.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'PROFILE_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'PERMISSION_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'GRANTED', type: 'boolean', default_value: 'false', indexed: true },
      ],
      refs: [
        { column: 'PROFILE_REF', parent: 'Profiles', from: 'PROFILE_ID', onDelete: 'ON-DELETE-CASCADE' },
        { column: 'PERMISSION_REF', parent: 'Permissions', from: 'PERMISSION_ID', onDelete: 'ON-DELETE-CASCADE' },
      ],
    },

    {
      name: 'AuditEvents',
      label: 'customer-side audit events',
      describes: 'Unified activity across products - logins, exports, record edits, permission changes.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'EVENT_ID', type: 'varchar', max_length: 40, indexed: true },
        { name: 'PRODUCT', type: 'varchar', values: ['crm', 'campaigns', 'desk'], max_length: 24, indexed: true },
        { name: 'USER_ID', type: 'varchar', max_length: 32, indexed: true },
        {
          name: 'EVENT_TYPE', type: 'varchar', max_length: 30, indexed: true,
          values: ['login', 'logout', 'export', 'record_view', 'record_edit', 'record_delete', 'permission_change', 'api_call'],
        },
        { name: 'MODULE', type: 'varchar', max_length: 60, indexed: true },
        { name: 'RECORD_ID', type: 'varchar', max_length: 40, indexed: true },
        { name: 'DETAILS', type: 'varchar', max_length: 255 },
        // Deliberately NOT pii: question 3 needs the IP visible to distinguish a
        // 4,000-row export from an unfamiliar address from three routine ones.
        { name: 'IP_ADDRESS', type: 'varchar', max_length: 45 },
        { name: 'OCCURRED_AT', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'USER_REF', parent: 'Users', from: 'USER_ID', onDelete: 'ON-DELETE-CASCADE' }],
    },
  ],

  commonQuestions: [
    {
      q: 'who hasn\'t logged in for 30 days',
      zcql:
        'SELECT Users.FULL_NAME, Users.EMAIL, Users.STATUS, Users.LAST_LOGIN FROM Users ' +
        "WHERE Users.LAST_LOGIN < '{{d-30}}' AND Users.STATUS = 'active' ORDER BY Users.LAST_LOGIN",
    },
    {
      q: 'which profiles can delete records',
      zcql:
        'SELECT Profiles.PROFILE_NAME, Profiles.PRODUCT, Permissions.MODULE, Permissions.PERMISSION_KEY ' +
        'FROM ProfilePermissions ' +
        'INNER JOIN Profiles ON ProfilePermissions.PROFILE_REF = Profiles.ROWID ' +
        'INNER JOIN Permissions ON ProfilePermissions.PERMISSION_REF = Permissions.ROWID ' +
        "WHERE Permissions.ACTION = 'delete' AND ProfilePermissions.GRANTED = 'true' " +
        'ORDER BY Profiles.PROFILE_NAME',
    },
  ],
};
