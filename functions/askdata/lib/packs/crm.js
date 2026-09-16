'use strict';

/**
 * Zoho CRM pack.
 *
 * `CRM_Leads.LEAD_SOURCE` is the most-requested field in the whole schema - it
 * is the answer to the escalation AskData exists to remove.
 *
 * `CRM_ExportJobs` is deliberately separate from `AuditEvents` even though an
 * export shows up in both. A security question deserves a table with row counts,
 * filters and IPs as columns, not a `DETAILS` string that has to be parsed
 * before it can be reasoned about.
 */

module.exports = {
  key: 'crm',
  label: 'Zoho CRM',

  synonyms: {
    'lead source': ['source', 'where did this lead come from', 'origin', 'lead origin', 'came from'],
    'deal': ['opportunity', 'potential', 'pipeline'],
    'lead': ['prospect', 'enquiry', 'inquiry'],
    'account': ['company', 'organisation', 'customer record'],
    'contact': ['person record'],
    'stage': ['deal stage', 'sales stage'],
    'amount': ['value', 'deal size', 'worth'],
    'export job': ['export', 'data download', 'csv download'],
    'field history': ['who changed', 'change log', 'audit of the field', 'edit history'],
    'workflow': ['workflow rule', 'automation', 'trigger'],
    'assignment rule': ['round robin', 'lead assignment', 'auto assign', 'routing'],
    'blueprint': ['process', 'sales process', 'stage transitions'],
    'duplicate rule': ['duplicate check', 'dedupe', 'deduplication', 'duplicate management', 'find and merge'],
    'sharing rule': ['data sharing', 'record sharing', 'sharing settings'],
  },

  piiColumns: [
    'CRM_Leads.FULL_NAME', 'CRM_Leads.EMAIL', 'CRM_Leads.PHONE',
    'CRM_Contacts.FULL_NAME', 'CRM_Contacts.EMAIL', 'CRM_Contacts.PHONE',
  ],

  tables: [
    {
      name: 'CRM_Leads',
      label: 'leads',
      describes:
        'A CRM lead. LEAD_SOURCE is the field customers ask about most; it can be ' +
        'NULL, and "why is the source blank?" is itself a common ticket.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'LEAD_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'FULL_NAME', type: 'varchar', max_length: 160, pii: 'name', indexed: true },
        { name: 'EMAIL', type: 'varchar', max_length: 200, pii: 'email', indexed: true },
        { name: 'PHONE', type: 'varchar', max_length: 40, pii: 'phone' },
        { name: 'COMPANY', type: 'varchar', max_length: 160, indexed: true },
        {
          name: 'LEAD_SOURCE', type: 'varchar', max_length: 60, indexed: true,
          values: ['Web Form', 'Trade Show', 'Referral', 'Cold Call', 'Partner', 'Advertisement', 'Webinar', 'Import'],
          describe: 'Null when never set - a blank source is a real support question',
        },
        {
          name: 'LEAD_STATUS', type: 'varchar', max_length: 40, indexed: true,
          values: ['New', 'Contacted', 'Qualified', 'Nurturing', 'Junk', 'Converted'],
        },
        { name: 'OWNER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'CONVERTED', type: 'boolean', default_value: 'false', indexed: true },
        { name: 'CONVERTED_ON', type: 'date' },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
        { name: 'MODIFIED_ON', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'OWNER_REF', parent: 'Users', from: 'OWNER_ID', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    {
      name: 'CRM_Accounts',
      label: 'accounts',
      describes: 'A company record in CRM. Contacts and deals hang off it.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'ACCOUNT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'ACCOUNT_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'INDUSTRY', type: 'varchar', max_length: 60, indexed: true },
        { name: 'OWNER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'OWNER_REF', parent: 'Users', from: 'OWNER_ID', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    {
      name: 'CRM_Contacts',
      label: 'contacts',
      describes: 'A person at an account. Every identifying column here is PII.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'CONTACT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'ACCOUNT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'FULL_NAME', type: 'varchar', max_length: 160, pii: 'name', indexed: true },
        { name: 'EMAIL', type: 'varchar', max_length: 200, pii: 'email', indexed: true },
        { name: 'PHONE', type: 'varchar', max_length: 40, pii: 'phone' },
        { name: 'TITLE', type: 'varchar', max_length: 100 },
        { name: 'OWNER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
      refs: [
        { column: 'ACCOUNT_REF', parent: 'CRM_Accounts', from: 'ACCOUNT_ID', onDelete: 'ON-DELETE-SET-NULL' },
        { column: 'OWNER_REF', parent: 'Users', from: 'OWNER_ID', onDelete: 'ON-DELETE-SET-NULL' },
      ],
    },

    {
      name: 'CRM_Deals',
      label: 'deals',
      describes: 'A sales opportunity. AMOUNT summed by STAGE is the pipeline question.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'DEAL_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'DEAL_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'ACCOUNT_ID', type: 'varchar', max_length: 32, indexed: true },
        {
          name: 'STAGE', type: 'varchar', max_length: 40, indexed: true,
          values: ['Qualification', 'Needs Analysis', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'],
        },
        { name: 'AMOUNT', type: 'double', decimal_digits: 2 },
        { name: 'CLOSING_DATE', type: 'date', indexed: true },
        { name: 'OWNER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
      refs: [
        { column: 'ACCOUNT_REF', parent: 'CRM_Accounts', from: 'ACCOUNT_ID', onDelete: 'ON-DELETE-SET-NULL' },
        { column: 'OWNER_REF', parent: 'Users', from: 'OWNER_ID', onDelete: 'ON-DELETE-SET-NULL' },
      ],
    },

    {
      name: 'CRM_ExportJobs',
      label: 'export jobs',
      describes:
        'One row per data export. ROW_COUNT, FILTER_APPLIED and IP_ADDRESS are columns ' +
        'precisely so a data-exfiltration question can be answered by looking, rather ' +
        'than by parsing a details string. An unfiltered export of thousands of rows at ' +
        'an odd hour from an unfamiliar IP is the signal; a count of exports hides it.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'EXPORT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'USER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'MODULE', type: 'varchar', max_length: 60, indexed: true },
        { name: 'FORMAT', type: 'varchar', max_length: 10, values: ['csv', 'xls', 'ics'] },
        { name: 'ROW_COUNT', type: 'int', indexed: true },
        { name: 'FILTER_APPLIED', type: 'varchar', max_length: 255, describe: 'Null or None means the whole module was taken' },
        // Deliberately NOT pii: question 3 needs the IP visible to distinguish a
        // 4,000-row export from an unfamiliar address from three routine ones.
        { name: 'IP_ADDRESS', type: 'varchar', max_length: 45 },
        { name: 'STATUS', type: 'varchar', max_length: 20, indexed: true, values: ['completed', 'failed', 'running'] },
        { name: 'EXPORTED_AT', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'USER_REF', parent: 'Users', from: 'USER_ID', onDelete: 'ON-DELETE-CASCADE' }],
    },

    {
      name: 'CRM_FieldHistory',
      label: 'field change history',
      describes:
        'Who changed a field on a record, from what to what. Answers "the source ' +
        'changed, who changed it?" - and an empty result is itself the answer to ' +
        '"has it changed since creation?".',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'HISTORY_ID', type: 'varchar', max_length: 40, indexed: true },
        { name: 'MODULE', type: 'varchar', max_length: 60, indexed: true },
        { name: 'RECORD_ID', type: 'varchar', max_length: 40, indexed: true },
        { name: 'FIELD_NAME', type: 'varchar', max_length: 60, indexed: true },
        { name: 'OLD_VALUE', type: 'varchar', max_length: 255 },
        { name: 'NEW_VALUE', type: 'varchar', max_length: 255 },
        { name: 'CHANGED_BY', type: 'varchar', max_length: 32, indexed: true },
        { name: 'CHANGED_AT', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'CHANGED_BY_REF', parent: 'Users', from: 'CHANGED_BY', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    /* ---- automation, data administration, security ------------------- */

    {
      name: 'CRM_WorkflowRules',
      listable: true,
      label: 'workflow rules',
      describes: 'A workflow rule: the module, what triggers it, what it does, how often it has fired.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'WORKFLOW_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'WORKFLOW_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'MODULE', type: 'varchar', max_length: 20, indexed: true, values: ['Leads', 'Contacts', 'Accounts', 'Deals', 'Tasks'] },
        { name: 'TRIGGER_ON', type: 'varchar', max_length: 24, indexed: true, values: ['create', 'edit', 'create_or_edit', 'delete', 'field_update', 'scheduled'] },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'inactive'] },
        { name: 'ACTION_TYPES', type: 'varchar', max_length: 255, describe: 'Email alerts tasks field updates webhooks functions' },
        { name: 'EXECUTIONS_30D', type: 'int' },
        { name: 'LAST_RUN_ON', type: 'datetime', indexed: true },
        { name: 'CREATED_BY', type: 'varchar', max_length: 32, indexed: true },
      ],
      refs: [{ column: 'CREATED_BY_REF', parent: 'Users', from: 'CREATED_BY', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    {
      name: 'CRM_AssignmentRules',
      listable: true,
      label: 'assignment rules',
      describes: 'How new records are distributed: round robin across a pool, or to a named owner by criteria.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'RULE_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'RULE_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'MODULE', type: 'varchar', max_length: 20, indexed: true, values: ['Leads', 'Contacts', 'Deals', 'Cases'] },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'inactive'] },
        { name: 'CRITERIA', type: 'varchar', max_length: 255 },
        { name: 'ROUND_ROBIN', type: 'boolean', default_value: 'false' },
        { name: 'ASSIGN_TO', type: 'varchar', max_length: 160, describe: 'A user or a round robin pool' },
        { name: 'RECORDS_ASSIGNED_30D', type: 'int' },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
    },

    {
      name: 'CRM_Blueprints',
      listable: true,
      label: 'blueprints',
      describes: 'A Blueprint process on a module: its states, transitions and how many records are mid process.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'BLUEPRINT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'BLUEPRINT_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'MODULE', type: 'varchar', max_length: 20, indexed: true, values: ['Leads', 'Deals', 'Contacts', 'Accounts'] },
        { name: 'LAYOUT', type: 'varchar', max_length: 80 },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'inactive', 'draft'] },
        { name: 'STATES', type: 'int' },
        { name: 'TRANSITIONS', type: 'int' },
        { name: 'RECORDS_IN_PROCESS', type: 'int' },
        { name: 'MODIFIED_ON', type: 'datetime', indexed: true },
      ],
    },

    {
      name: 'CRM_DuplicateRules',
      listable: true,
      label: 'duplicate rules',
      describes: 'Duplicate management per module: which fields must match, what happens on a match, what the last check found.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'RULE_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'MODULE', type: 'varchar', max_length: 20, indexed: true, values: ['Leads', 'Contacts', 'Accounts', 'Deals'] },
        { name: 'MATCH_FIELDS', type: 'varchar', max_length: 255, describe: 'Fields compared for a duplicate' },
        { name: 'ACTION_ON_DUPLICATE', type: 'varchar', max_length: 24, indexed: true, values: ['block', 'merge', 'allow_with_warning'] },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'inactive'] },
        { name: 'DUPLICATES_FOUND_LAST_RUN', type: 'int' },
        { name: 'LAST_RUN_ON', type: 'datetime', indexed: true },
      ],
    },

    {
      name: 'CRM_SharingRules',
      listable: true,
      label: 'data sharing rules',
      describes: 'A data sharing rule: which role or group shares records with which, and at what access level.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'RULE_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'RULE_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'MODULE', type: 'varchar', max_length: 20, indexed: true, values: ['Leads', 'Contacts', 'Accounts', 'Deals'] },
        { name: 'SHARE_FROM', type: 'varchar', max_length: 120 },
        { name: 'SHARE_TO', type: 'varchar', max_length: 120 },
        { name: 'ACCESS_LEVEL', type: 'varchar', max_length: 16, indexed: true, values: ['read_only', 'read_write', 'full'] },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'inactive'] },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
    },
  ],

  commonQuestions: [
    {
      q: 'is there a duplicate rule on leads',
      zcql:
        'SELECT CRM_DuplicateRules.MODULE, CRM_DuplicateRules.MATCH_FIELDS, CRM_DuplicateRules.ACTION_ON_DUPLICATE, ' +
        'CRM_DuplicateRules.STATUS, CRM_DuplicateRules.DUPLICATES_FOUND_LAST_RUN FROM CRM_DuplicateRules ' +
        "WHERE CRM_DuplicateRules.MODULE = 'Leads'",
    },
    {
      q: 'which workflow rules are active on leads',
      zcql:
        'SELECT CRM_WorkflowRules.WORKFLOW_NAME, CRM_WorkflowRules.TRIGGER_ON, CRM_WorkflowRules.ACTION_TYPES, ' +
        "CRM_WorkflowRules.EXECUTIONS_30D FROM CRM_WorkflowRules WHERE CRM_WorkflowRules.MODULE = 'Leads' AND CRM_WorkflowRules.STATUS = 'active'",
    },
    {
      q: "what's the source of lead 4551000000234017",
      zcql:
        'SELECT CRM_Leads.LEAD_ID, CRM_Leads.LEAD_SOURCE, CRM_Leads.LEAD_STATUS, ' +
        'CRM_Leads.CREATED_ON, CRM_Leads.MODIFIED_ON FROM CRM_Leads ' +
        "WHERE CRM_Leads.LEAD_ID = '4551000000234017'",
    },
    {
      q: 'break down leads by source',
      zcql:
        'SELECT CRM_Leads.LEAD_SOURCE, COUNT(ROWID) FROM CRM_Leads ' +
        'GROUP BY CRM_Leads.LEAD_SOURCE ORDER BY COUNT(ROWID) DESC',
    },
    {
      q: 'which leads have no source set',
      zcql:
        'SELECT CRM_Leads.LEAD_ID, CRM_Leads.COMPANY, CRM_Leads.LEAD_STATUS, CRM_Leads.CREATED_ON ' +
        'FROM CRM_Leads WHERE CRM_Leads.LEAD_SOURCE IS NULL ORDER BY CRM_Leads.CREATED_ON DESC',
    },
    {
      q: 'did the user with id U-1007 export any data from CRM',
      zcql:
        'SELECT CRM_ExportJobs.EXPORTED_AT, CRM_ExportJobs.MODULE, CRM_ExportJobs.ROW_COUNT, ' +
        'CRM_ExportJobs.FILTER_APPLIED, CRM_ExportJobs.IP_ADDRESS, CRM_ExportJobs.FORMAT ' +
        "FROM CRM_ExportJobs WHERE CRM_ExportJobs.USER_ID = 'U-1007' " +
        'ORDER BY CRM_ExportJobs.ROW_COUNT DESC',
    },
    {
      q: 'total pipeline value by stage',
      zcql:
        'SELECT CRM_Deals.STAGE, COUNT(ROWID), SUM(CRM_Deals.AMOUNT) FROM CRM_Deals ' +
        'GROUP BY CRM_Deals.STAGE ORDER BY SUM(CRM_Deals.AMOUNT) DESC',
    },
    {
      q: 'who changed the source on lead 4551000000234021 and what was it before',
      zcql:
        'SELECT CRM_FieldHistory.CHANGED_AT, CRM_FieldHistory.OLD_VALUE, CRM_FieldHistory.NEW_VALUE, ' +
        'Users.FULL_NAME FROM CRM_FieldHistory ' +
        'LEFT JOIN Users ON CRM_FieldHistory.CHANGED_BY_REF = Users.ROWID ' +
        "WHERE CRM_FieldHistory.RECORD_ID = '4551000000234021' AND CRM_FieldHistory.FIELD_NAME = 'LEAD_SOURCE' " +
        'ORDER BY CRM_FieldHistory.CHANGED_AT DESC',
    },
  ],
};
