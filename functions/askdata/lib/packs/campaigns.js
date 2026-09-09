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
  ],

  commonQuestions: [
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
