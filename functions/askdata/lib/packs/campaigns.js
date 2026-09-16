'use strict';

/** Zoho Campaigns pack - lists, the segments built from them, and sends. */

module.exports = {
  key: 'campaigns',
  label: 'Zoho Campaigns',

  synonyms: {
    'list': ['mailing list', 'subscriber list', 'contact list', 'audience'],
    'segment': ['sub list', 'filter', 'saved filter', 'audience segment'],
    'campaign': ['mailer', 'email blast', 'send', 'broadcast', 'newsletter'],
    'open rate': ['opens', 'engagement', 'how many opened'],
    'sent count': ['recipients', 'how many were sent', 'volume'],
    'sending domain': ['sender domain', 'dkim', 'spf', 'dmarc', 'domain authentication', 'email authentication'],
    'journey': ['automation', 'workflow', 'drip', 'autoresponder', 'automated series'],
    'signup form': ['form', 'popup form', 'subscribe form', 'embedded form'],
    'a/b test': ['ab test', 'split test', 'subject line test'],
    'topic': ['subscription topic', 'preference', 'frequency cap'],
  },

  piiColumns: [],

  tables: [
    {
      name: 'CMP_Lists',
      listable: true,
      label: 'mailing lists',
      describes: 'A subscriber list. Segments and campaigns both hang off it.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'LIST_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'LIST_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'CONTACT_COUNT', type: 'int' },
        { name: 'OWNER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'OWNER_REF', parent: 'Users', from: 'OWNER_ID', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    {
      name: 'CMP_Segments',
      listable: true,
      label: 'list segments',
      describes:
        'A saved filter over a list. Creating one needs the campaigns.segments.create ' +
        'permission, which is what "my user cannot create a segment" resolves to.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'SEGMENT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'LIST_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'SEGMENT_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'CRITERIA', type: 'varchar', max_length: 255 },
        { name: 'CREATED_BY', type: 'varchar', max_length: 32, indexed: true },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
      refs: [
        { column: 'LIST_REF', parent: 'CMP_Lists', from: 'LIST_ID', onDelete: 'ON-DELETE-CASCADE' },
        { column: 'CREATED_BY_REF', parent: 'Users', from: 'CREATED_BY', onDelete: 'ON-DELETE-SET-NULL' },
      ],
    },

    {
      name: 'CMP_Campaigns',
      listable: true,
      label: 'campaigns',
      describes: 'An email campaign sent to a list.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'CAMPAIGN_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'CAMPAIGN_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'LIST_ID', type: 'varchar', max_length: 32, indexed: true },
        {
          name: 'STATUS', type: 'varchar', max_length: 20, indexed: true,
          values: ['draft', 'scheduled', 'sent', 'paused'],
        },
        { name: 'SENT_COUNT', type: 'int' },
        { name: 'OPEN_RATE', type: 'double', decimal_digits: 2 },
        { name: 'SENT_ON', type: 'datetime', indexed: true },
        { name: 'CREATED_BY', type: 'varchar', max_length: 32, indexed: true },
      ],
      refs: [
        { column: 'LIST_REF', parent: 'CMP_Lists', from: 'LIST_ID', onDelete: 'ON-DELETE-SET-NULL' },
        { column: 'CREATED_BY_REF', parent: 'Users', from: 'CREATED_BY', onDelete: 'ON-DELETE-SET-NULL' },
      ],
    },

    /* ---- deliverability, automation, capture, testing, preferences ---- */

    {
      name: 'CMP_SenderDomains',
      listable: true,
      label: 'sending domains',
      describes: 'A domain the org sends campaigns from, with its SPF, DKIM and DMARC authentication status.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'DOMAIN_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'DOMAIN_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'SPF_STATUS', type: 'varchar', max_length: 20, indexed: true, values: ['verified', 'pending', 'failed', 'not_configured'] },
        { name: 'DKIM_STATUS', type: 'varchar', max_length: 20, indexed: true, values: ['verified', 'pending', 'failed', 'not_configured'] },
        { name: 'DMARC_STATUS', type: 'varchar', max_length: 20, indexed: true, values: ['verified', 'pending', 'failed', 'not_configured'] },
        { name: 'DEDICATED_IP', type: 'boolean', default_value: 'false' },
        { name: 'IS_DEFAULT', type: 'boolean', default_value: 'false' },
        { name: 'VERIFIED_ON', type: 'datetime' },
      ],
    },

    {
      name: 'CMP_Journeys',
      listable: true,
      label: 'automated journeys',
      describes: 'An automation journey: what starts it, how many contacts are in it, how many steps it has.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'JOURNEY_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'JOURNEY_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'LIST_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'paused', 'draft', 'completed'] },
        { name: 'TRIGGER_TYPE', type: 'varchar', max_length: 24, indexed: true, values: ['form_submission', 'list_entry', 'segment_entry', 'email_action', 'date_field', 'tag_assigned', 'abandoned_cart', 'cyclic'] },
        { name: 'STEPS', type: 'int' },
        { name: 'CONTACTS_IN_JOURNEY', type: 'int' },
        { name: 'CREATED_BY', type: 'varchar', max_length: 32, indexed: true },
        { name: 'MODIFIED_ON', type: 'datetime', indexed: true },
      ],
      refs: [
        { column: 'LIST_REF', parent: 'CMP_Lists', from: 'LIST_ID', onDelete: 'ON-DELETE-SET-NULL' },
        { column: 'CREATED_BY_REF', parent: 'Users', from: 'CREATED_BY', onDelete: 'ON-DELETE-SET-NULL' },
      ],
    },

    {
      name: 'CMP_SignupForms',
      listable: true,
      label: 'signup forms',
      describes: 'An embedded, pop up or hosted signup form and the list it feeds.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'FORM_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'FORM_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'FORM_TYPE', type: 'varchar', max_length: 16, indexed: true, values: ['embedded', 'popup', 'hosted'] },
        { name: 'LIST_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'inactive'] },
        { name: 'DOUBLE_OPT_IN', type: 'boolean', default_value: 'false' },
        { name: 'SUBMISSIONS_30D', type: 'int' },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'LIST_REF', parent: 'CMP_Lists', from: 'LIST_ID', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    {
      name: 'CMP_AbTests',
      listable: true,
      label: 'A/B tests',
      describes: 'An A/B test run on a campaign: what was varied, how each variant opened, which won.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'TEST_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'CAMPAIGN_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'TEST_TYPE', type: 'varchar', max_length: 20, indexed: true, values: ['subject_line', 'sender_name', 'content', 'send_time'] },
        { name: 'SAMPLE_SIZE', type: 'int' },
        { name: 'VARIANT_A_OPEN_RATE', type: 'double', decimal_digits: 2 },
        { name: 'VARIANT_B_OPEN_RATE', type: 'double', decimal_digits: 2 },
        { name: 'WINNER', type: 'varchar', max_length: 12, indexed: true, values: ['A', 'B', 'undecided'] },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['running', 'completed', 'cancelled'] },
        { name: 'COMPLETED_ON', type: 'datetime' },
      ],
      refs: [{ column: 'CAMPAIGN_REF', parent: 'CMP_Campaigns', from: 'CAMPAIGN_ID', onDelete: 'ON-DELETE-CASCADE' }],
    },

    {
      name: 'CMP_Topics',
      listable: true,
      label: 'topics',
      describes: 'A subscription topic contacts can opt into, with its frequency cap.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'TOPIC_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'TOPIC_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'SUBSCRIBERS', type: 'int' },
        { name: 'FREQUENCY_CAP_PER_WEEK', type: 'int', describe: 'Maximum emails a contact receives per week' },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'archived'] },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
    },
  ],

  commonQuestions: [
    {
      q: 'is the sending domain authenticated',
      zcql:
        'SELECT CMP_SenderDomains.DOMAIN_NAME, CMP_SenderDomains.SPF_STATUS, CMP_SenderDomains.DKIM_STATUS, ' +
        'CMP_SenderDomains.DMARC_STATUS, CMP_SenderDomains.DEDICATED_IP FROM CMP_SenderDomains',
    },
    {
      q: 'which journeys are active',
      zcql:
        'SELECT CMP_Journeys.JOURNEY_NAME, CMP_Journeys.TRIGGER_TYPE, CMP_Journeys.CONTACTS_IN_JOURNEY, ' +
        "CMP_Journeys.STEPS FROM CMP_Journeys WHERE CMP_Journeys.STATUS = 'active' ORDER BY CMP_Journeys.CONTACTS_IN_JOURNEY DESC",
    },
    {
      q: 'can the user with id U-2004 create a segment in campaigns',
      zcql:
        'SELECT Users.FULL_NAME, Profiles.PROFILE_NAME, Permissions.PERMISSION_KEY, ' +
        'ProfilePermissions.GRANTED FROM UserProfiles ' +
        'INNER JOIN Users ON UserProfiles.USER_REF = Users.ROWID ' +
        'INNER JOIN Profiles ON UserProfiles.PROFILE_REF = Profiles.ROWID ' +
        'INNER JOIN ProfilePermissions ON ProfilePermissions.PROFILE_REF = Profiles.ROWID ' +
        'INNER JOIN Permissions ON ProfilePermissions.PERMISSION_REF = Permissions.ROWID ' +
        "WHERE Users.USER_ID = 'U-2004' AND Permissions.PERMISSION_KEY = 'campaigns.segments.create'",
    },
    {
      q: 'list the segments',
      zcql:
        'SELECT CMP_Segments.SEGMENT_NAME, CMP_Segments.CRITERIA, CMP_Lists.LIST_NAME, ' +
        'CMP_Segments.CREATED_ON FROM CMP_Segments ' +
        'LEFT JOIN CMP_Lists ON CMP_Segments.LIST_REF = CMP_Lists.ROWID ' +
        'ORDER BY CMP_Segments.CREATED_ON DESC',
    },
  ],
};
