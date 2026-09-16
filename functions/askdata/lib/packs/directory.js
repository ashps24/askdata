'use strict';

/**
 * Zoho Directory pack.
 *
 * Directory is the identity layer under every other product: which domains the
 * org owns, which apps its people can reach, what security policies bind them.
 * The questions here are the ones a TAM wants answered BEFORE replying at all -
 * "has this org even configured MFA?" changes the whole shape of the answer.
 *
 * Tables follow what an admin actually configures in the Directory web app:
 * domains, applications and their assignments, security policies, and groups.
 */

module.exports = {
  key: 'directory',
  label: 'Zoho Directory',

  synonyms: {
    'domain': ['verified domain', 'company domain', 'email domain'],
    'application': ['app', 'sso app', 'connected app', 'integration'],
    'security policy': ['policy', 'password policy', 'mfa', 'two factor', '2fa', 'ip restriction', 'session policy'],
    'group': ['team', 'department', 'collaboration group'],
    'tenant': ['directory tenant', 'ad tenant', 'connected tenant', 'directory store'],
  },

  piiColumns: [],

  tables: [
    {
      name: 'DIR_Domains',
      listable: true,
      label: 'verified domains',
      describes: 'A domain the org has added to Directory, and the tenant it syncs from.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'DOMAIN_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'DOMAIN_NAME', type: 'varchar', max_length: 160, indexed: true },
        {
          name: 'VERIFICATION_STATUS', type: 'varchar', max_length: 20, indexed: true,
          values: ['verified', 'pending', 'failed'],
        },
        { name: 'VERIFIED_ON', type: 'datetime' },
        { name: 'TENANT_ID', type: 'varchar', max_length: 64, indexed: true, describe: 'The directory tenant this domain is connected to' },
        { name: 'TENANT_NAME', type: 'varchar', max_length: 160 },
        {
          name: 'SYNC_SOURCE', type: 'varchar', max_length: 24, indexed: true,
          values: ['none', 'active_directory', 'ldap', 'google_workspace', 'azure_ad'],
        },
        { name: 'IS_PRIMARY', type: 'boolean', default_value: 'false' },
      ],
    },

    {
      name: 'DIR_SecurityPolicies',
      listable: true,
      label: 'security policies',
      describes: 'One row per security policy: password rules, MFA, IP restriction, session and device policies.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'POLICY_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'POLICY_NAME', type: 'varchar', max_length: 160, indexed: true },
        {
          name: 'POLICY_TYPE', type: 'varchar', max_length: 24, indexed: true,
          values: ['password', 'mfa', 'ip_restriction', 'session', 'device'],
        },
        {
          name: 'STATUS', type: 'varchar', max_length: 16, indexed: true,
          values: ['enforced', 'optional', 'disabled'],
        },
        { name: 'APPLIES_TO', type: 'varchar', max_length: 120, describe: 'all users or a named group' },
        { name: 'SETTINGS', type: 'varchar', max_length: 255, describe: 'Human readable summary of the policy' },
        { name: 'MODIFIED_BY', type: 'varchar', max_length: 32, indexed: true },
        { name: 'MODIFIED_ON', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'MODIFIED_BY_REF', parent: 'Users', from: 'MODIFIED_BY', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    {
      name: 'DIR_Applications',
      listable: true,
      label: 'applications',
      describes: 'An app connected to Directory for SSO or provisioning, Zoho or third party.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'APP_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'APP_NAME', type: 'varchar', max_length: 160, indexed: true },
        {
          name: 'APP_TYPE', type: 'varchar', max_length: 20, indexed: true,
          values: ['zoho', 'saml', 'oidc', 'password_vault'],
        },
        { name: 'SSO_ENABLED', type: 'boolean', default_value: 'false' },
        {
          name: 'PROVISIONING', type: 'varchar', max_length: 16, indexed: true,
          values: ['manual', 'scim', 'jit'],
        },
        { name: 'ASSIGNED_USERS', type: 'int' },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'disabled'] },
        { name: 'ADDED_ON', type: 'datetime', indexed: true },
      ],
    },

    {
      name: 'DIR_UserApplications',
      label: 'app assignments',
      describes: 'Which users are assigned to which applications. This is the "is this user part of any apps" table.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'ASSIGNMENT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'USER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'APP_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'ROLE_IN_APP', type: 'varchar', max_length: 60 },
        { name: 'ASSIGNED_ON', type: 'datetime', indexed: true },
        { name: 'LAST_ACCESSED', type: 'datetime', indexed: true },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'suspended'] },
      ],
      refs: [
        { column: 'USER_REF', parent: 'Users', from: 'USER_ID', onDelete: 'ON-DELETE-CASCADE' },
        { column: 'APP_REF', parent: 'DIR_Applications', from: 'APP_ID', onDelete: 'ON-DELETE-CASCADE' },
      ],
    },

    {
      name: 'DIR_Groups',
      listable: true,
      label: 'groups',
      describes: 'A Directory group: a department reflecting the org chart, or a collaboration group.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'GROUP_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'GROUP_NAME', type: 'varchar', max_length: 160, indexed: true },
        {
          name: 'GROUP_TYPE', type: 'varchar', max_length: 20, indexed: true,
          values: ['department', 'collaboration'],
        },
        { name: 'MEMBER_COUNT', type: 'int' },
        { name: 'OWNER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'OWNER_REF', parent: 'Users', from: 'OWNER_ID', onDelete: 'ON-DELETE-SET-NULL' }],
    },
  ],

  commonQuestions: [
    {
      q: 'have security policies been configured in this org',
      zcql:
        'SELECT DIR_SecurityPolicies.POLICY_NAME, DIR_SecurityPolicies.POLICY_TYPE, ' +
        'DIR_SecurityPolicies.STATUS, DIR_SecurityPolicies.APPLIES_TO FROM DIR_SecurityPolicies ' +
        'ORDER BY DIR_SecurityPolicies.POLICY_TYPE',
    },
    {
      q: 'which tenant is this org connected to',
      zcql:
        'SELECT DIR_Domains.DOMAIN_NAME, DIR_Domains.TENANT_NAME, DIR_Domains.SYNC_SOURCE, ' +
        'DIR_Domains.VERIFICATION_STATUS FROM DIR_Domains ORDER BY DIR_Domains.IS_PRIMARY DESC',
    },
    {
      q: 'is the user with id U-1005 part of any apps',
      zcql:
        'SELECT DIR_Applications.APP_NAME, DIR_Applications.APP_TYPE, DIR_UserApplications.ROLE_IN_APP, ' +
        'DIR_UserApplications.LAST_ACCESSED FROM DIR_UserApplications ' +
        'INNER JOIN DIR_Applications ON DIR_UserApplications.APP_REF = DIR_Applications.ROWID ' +
        "WHERE DIR_UserApplications.USER_ID = 'U-1005' ORDER BY DIR_UserApplications.LAST_ACCESSED DESC",
    },
  ],
};
