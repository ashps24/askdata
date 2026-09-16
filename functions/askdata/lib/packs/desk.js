'use strict';

/**
 * Zoho Desk pack.
 *
 * `DESK_Tickets.TICKET_PRIORITY` is not a typo. Data Store refuses `PRIORITY`
 * as a column name ("Column name cannot contain reserved keywords"), so the
 * column is renamed and `askedAs` tells the prompt the word a person will use.
 */

module.exports = {
  key: 'desk',
  label: 'Zoho Desk',

  synonyms: {
    'department': ['dept', 'team', 'queue', 'group'],
    'ticket': ['case', 'request', 'issue'],
    'assignee': ['owner', 'agent handling it', 'assigned to'],
    'priority': ['urgency', 'severity'],
    'role in department': ['role', 'agent or lead or manager'],
    'dmarc': ['dkim', 'spf', 'email authentication', 'domain authentication', 'sender authentication'],
    'guided conversation': ['gc', 'gc flow', 'chat flow', 'bot flow', 'decision tree'],
    'custom function': ['deluge function', 'function', 'script'],
    'assignment rule': ['round robin', 'skill based', 'auto assign', 'auto assignment', 'ticket routing'],
    'help center': ['portal', 'customer portal', 'knowledge base', 'kb', 'self service'],
    'business hours': ['working hours', 'operating hours', 'schedule', 'holidays'],
    'workflow': ['workflow rule', 'automation'],
  },

  piiColumns: ['DESK_Tickets.CONTACT_EMAIL'],

  tables: [
    {
      name: 'DESK_Departments',
      listable: true,
      label: 'departments',
      describes: 'A Desk department, i.e. a ticket queue with its own members.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'DEPARTMENT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'DEPARTMENT_NAME', type: 'varchar', max_length: 120, indexed: true },
        { name: 'IS_DEFAULT', type: 'boolean', default_value: 'false' },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
    },

    {
      name: 'DESK_DepartmentMembers',
      label: 'department membership',
      describes:
        'Which users are in which department, and in what role. When an admin says ' +
        'someone "should be in X but is not", the useful answer lists the departments ' +
        'they ARE in - a bare "no" sends the admin straight back to a debug engineer.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'MEMBER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'DEPARTMENT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'USER_ID', type: 'varchar', max_length: 32, indexed: true },
        {
          name: 'ROLE_IN_DEPT', type: 'varchar', max_length: 20, indexed: true,
          values: ['agent', 'lead', 'manager'],
        },
        { name: 'ADDED_ON', type: 'date' },
      ],
      refs: [
        { column: 'DEPARTMENT_REF', parent: 'DESK_Departments', from: 'DEPARTMENT_ID', onDelete: 'ON-DELETE-CASCADE' },
        { column: 'USER_REF', parent: 'Users', from: 'USER_ID', onDelete: 'ON-DELETE-CASCADE' },
      ],
    },

    {
      name: 'DESK_Tickets',
      label: 'support tickets',
      describes: 'A ticket raised by the customer\'s own end users.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'TICKET_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'DEPARTMENT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'SUBJECT', type: 'varchar', max_length: 250, indexed: true },
        {
          name: 'STATUS', type: 'varchar', max_length: 20, indexed: true,
          values: ['Open', 'On Hold', 'Escalated', 'Closed'],
        },
        {
          name: 'TICKET_PRIORITY', type: 'varchar', max_length: 20, indexed: true,
          askedAs: 'priority',
          values: ['Low', 'Medium', 'High', 'Urgent'],
          describe: 'The priority field. Named TICKET_PRIORITY because PRIORITY is reserved',
        },
        { name: 'ASSIGNEE_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'CONTACT_EMAIL', type: 'varchar', max_length: 200, pii: 'email', indexed: true },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
      refs: [
        { column: 'DEPARTMENT_REF', parent: 'DESK_Departments', from: 'DEPARTMENT_ID', onDelete: 'ON-DELETE-SET-NULL' },
        { column: 'ASSIGNEE_REF', parent: 'Users', from: 'ASSIGNEE_ID', onDelete: 'ON-DELETE-SET-NULL' },
      ],
    },

    /* ---- configuration a support engineer checks before replying ------ */

    {
      name: 'DESK_EmailConfig',
      listable: true,
      label: 'support email configuration',
      describes: 'One row per support address: SPF, DKIM and DMARC status for the domain it sends from.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'EMAIL_CONFIG_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'SUPPORT_EMAIL', type: 'varchar', max_length: 200, indexed: true, describe: 'The shared support address not a person' },
        { name: 'DEPARTMENT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'SENDING_DOMAIN', type: 'varchar', max_length: 160, indexed: true },
        { name: 'SPF_STATUS', type: 'varchar', max_length: 20, indexed: true, values: ['verified', 'pending', 'failed', 'not_configured'] },
        { name: 'DKIM_STATUS', type: 'varchar', max_length: 20, indexed: true, values: ['verified', 'pending', 'failed', 'not_configured'] },
        { name: 'DMARC_STATUS', type: 'varchar', max_length: 20, indexed: true, values: ['verified', 'pending', 'failed', 'not_configured'] },
        { name: 'DMARC_POLICY', type: 'varchar', max_length: 16, values: ['none', 'quarantine', 'reject', 'not_set'] },
        { name: 'LAST_VERIFIED_ON', type: 'datetime' },
      ],
      refs: [{ column: 'DEPARTMENT_REF', parent: 'DESK_Departments', from: 'DEPARTMENT_ID', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    {
      name: 'DESK_GuidedConversations',
      listable: true,
      label: 'guided conversation flows',
      describes: 'A Guided Conversations flow: the self-service decision tree offered on a channel.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'FLOW_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'FLOW_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'DEPARTMENT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['published', 'draft', 'disabled'] },
        { name: 'CHANNEL', type: 'varchar', max_length: 20, indexed: true, values: ['help_center', 'asap', 'whatsapp', 'web_widget'] },
        { name: 'BLOCK_COUNT', type: 'int' },
        { name: 'SESSIONS_30D', type: 'int', describe: 'Sessions started in the last 30 days' },
        { name: 'CREATED_BY', type: 'varchar', max_length: 32, indexed: true },
        { name: 'MODIFIED_ON', type: 'datetime', indexed: true },
      ],
      refs: [
        { column: 'DEPARTMENT_REF', parent: 'DESK_Departments', from: 'DEPARTMENT_ID', onDelete: 'ON-DELETE-SET-NULL' },
        { column: 'CREATED_BY_REF', parent: 'Users', from: 'CREATED_BY', onDelete: 'ON-DELETE-SET-NULL' },
      ],
    },

    {
      name: 'DESK_CustomFunctions',
      listable: true,
      label: 'custom functions',
      describes: 'A Deluge custom function and where it is triggered from.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'FUNCTION_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'FUNCTION_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'TRIGGER_TYPE', type: 'varchar', max_length: 20, indexed: true, values: ['workflow', 'schedule', 'blueprint', 'manual', 'api'] },
        { name: 'LINKED_TO', type: 'varchar', max_length: 160, describe: 'The workflow or schedule that invokes it' },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'inactive', 'error'] },
        { name: 'EXECUTIONS_30D', type: 'int' },
        { name: 'FAILURES_30D', type: 'int' },
        { name: 'LAST_ERROR', type: 'varchar', max_length: 255 },
        { name: 'LAST_RUN_ON', type: 'datetime', indexed: true },
        { name: 'CREATED_BY', type: 'varchar', max_length: 32, indexed: true },
      ],
      refs: [{ column: 'CREATED_BY_REF', parent: 'Users', from: 'CREATED_BY', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    {
      name: 'DESK_AssignmentRules',
      listable: true,
      label: 'assignment rules',
      describes: 'How new tickets are handed to agents: round robin, skill based, load balanced or direct.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'RULE_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'RULE_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'DEPARTMENT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'RULE_TYPE', type: 'varchar', max_length: 20, indexed: true, values: ['round_robin', 'skill_based', 'load_balanced', 'direct'] },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'inactive'] },
        { name: 'CRITERIA', type: 'varchar', max_length: 255, describe: 'When the rule applies' },
        { name: 'SKILLS', type: 'varchar', max_length: 255, describe: 'Skills matched for skill based rules' },
        { name: 'AGENT_COUNT', type: 'int' },
        { name: 'TICKETS_ASSIGNED_30D', type: 'int' },
        { name: 'CREATED_ON', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'DEPARTMENT_REF', parent: 'DESK_Departments', from: 'DEPARTMENT_ID', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    {
      name: 'DESK_BusinessHours',
      listable: true,
      label: 'business hours',
      describes: 'A business hours schedule used by SLAs and telephony.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'SCHEDULE_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'SCHEDULE_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'TIMEZONE', type: 'varchar', max_length: 60 },
        { name: 'WORKING_DAYS', type: 'varchar', max_length: 60 },
        { name: 'START_TIME', type: 'varchar', max_length: 8 },
        { name: 'END_TIME', type: 'varchar', max_length: 8 },
        { name: 'HOLIDAYS_COUNT', type: 'int' },
        { name: 'IS_DEFAULT', type: 'boolean', default_value: 'false' },
        { name: 'USED_BY_SLA', type: 'boolean', default_value: 'false' },
      ],
    },

    {
      name: 'DESK_HelpCenters',
      listable: true,
      label: 'help centers',
      describes: 'A customer facing help center: portal access, knowledge base, community and the ASAP widget.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'HELP_CENTER_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'HELP_CENTER_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'PORTAL_URL', type: 'varchar', max_length: 255 },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['live', 'draft', 'disabled'] },
        { name: 'ACCESS', type: 'varchar', max_length: 20, indexed: true, values: ['public', 'login_required', 'private'] },
        { name: 'KB_ARTICLES', type: 'int' },
        { name: 'COMMUNITY_ENABLED', type: 'boolean', default_value: 'false' },
        { name: 'ASAP_ENABLED', type: 'boolean', default_value: 'false' },
        { name: 'CUSTOM_DOMAIN', type: 'boolean', default_value: 'false' },
        { name: 'THEME', type: 'varchar', max_length: 60 },
        { name: 'LAUNCHED_ON', type: 'date' },
      ],
    },

    {
      name: 'DESK_WorkflowRules',
      listable: true,
      label: 'workflow rules',
      describes: 'A workflow rule: what triggers it and what it does.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'WORKFLOW_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'WORKFLOW_NAME', type: 'varchar', max_length: 160, indexed: true },
        { name: 'DEPARTMENT_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'MODULE', type: 'varchar', max_length: 20, indexed: true, values: ['Tickets', 'Contacts', 'Accounts'] },
        { name: 'TRIGGER_ON', type: 'varchar', max_length: 24, indexed: true, values: ['create', 'update', 'create_or_update', 'time_based'] },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['active', 'inactive'] },
        { name: 'ACTION_TYPES', type: 'varchar', max_length: 255, describe: 'Alerts field updates custom functions' },
        { name: 'EXECUTIONS_30D', type: 'int' },
        { name: 'LAST_RUN_ON', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'DEPARTMENT_REF', parent: 'DESK_Departments', from: 'DEPARTMENT_ID', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    {
      name: 'DESK_SecuritySettings',
      listable: true,
      label: 'security settings',
      describes: 'One row per org level security control: IP range restriction, CSP header, field encryption, idle timeout, attachment controls.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'SETTING_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'SETTING_NAME', type: 'varchar', max_length: 120, indexed: true, values: ['IP range restriction', 'CSP policy header', 'Field encryption', 'System field encryption', 'Agent idle timeout', 'Attachment controls'] },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['enabled', 'disabled'] },
        { name: 'SETTING_VALUE', type: 'varchar', max_length: 255 },
        { name: 'MODIFIED_BY', type: 'varchar', max_length: 32, indexed: true },
        { name: 'MODIFIED_ON', type: 'datetime', indexed: true },
      ],
      refs: [{ column: 'MODIFIED_BY_REF', parent: 'Users', from: 'MODIFIED_BY', onDelete: 'ON-DELETE-SET-NULL' }],
    },

    {
      name: 'DESK_ZiaSettings',
      listable: true,
      label: 'Zia settings',
      describes: 'Which Zia features are switched on: field predictions, answer bot, sentiment analysis, auto tags.',
      columns: [
        { name: 'ORG_ID', type: 'varchar', max_length: 64, mandatory: true, indexed: true },
        { name: 'ZIA_SETTING_ID', type: 'varchar', max_length: 32, indexed: true },
        { name: 'FEATURE', type: 'varchar', max_length: 60, indexed: true, values: ['Field predictions', 'Answer bot', 'Sentiment analysis', 'Ticket auto tags', 'Reply assistant', 'Anomaly detection'] },
        { name: 'STATUS', type: 'varchar', max_length: 16, indexed: true, values: ['enabled', 'disabled', 'training'] },
        { name: 'AI_PROVIDER', type: 'varchar', max_length: 20, values: ['native', 'byok_openai', 'byok_azure'] },
        { name: 'DEPARTMENTS_COVERED', type: 'int' },
        { name: 'ENABLED_ON', type: 'datetime' },
      ],
    },
  ],

  commonQuestions: [
    {
      q: 'has dmarc been configured in this desk org',
      zcql:
        'SELECT DESK_EmailConfig.SUPPORT_EMAIL, DESK_EmailConfig.SENDING_DOMAIN, DESK_EmailConfig.SPF_STATUS, ' +
        'DESK_EmailConfig.DKIM_STATUS, DESK_EmailConfig.DMARC_STATUS, DESK_EmailConfig.DMARC_POLICY ' +
        'FROM DESK_EmailConfig ORDER BY DESK_EmailConfig.SUPPORT_EMAIL',
    },
    {
      q: 'is there a round robin assignment rule set up',
      zcql:
        'SELECT DESK_AssignmentRules.RULE_NAME, DESK_AssignmentRules.RULE_TYPE, DESK_AssignmentRules.STATUS, ' +
        'DESK_Departments.DEPARTMENT_NAME, DESK_AssignmentRules.AGENT_COUNT FROM DESK_AssignmentRules ' +
        'LEFT JOIN DESK_Departments ON DESK_AssignmentRules.DEPARTMENT_REF = DESK_Departments.ROWID ' +
        'ORDER BY DESK_AssignmentRules.RULE_TYPE',
    },
    {
      q: 'is the customer portal in use',
      zcql:
        'SELECT DESK_HelpCenters.HELP_CENTER_NAME, DESK_HelpCenters.STATUS, DESK_HelpCenters.ACCESS, ' +
        'DESK_HelpCenters.KB_ARTICLES, DESK_HelpCenters.ASAP_ENABLED FROM DESK_HelpCenters',
    },
    {
      q: 'which departments is the user with id U-3005 in',
      zcql:
        'SELECT DESK_Departments.DEPARTMENT_NAME, DESK_DepartmentMembers.ROLE_IN_DEPT, ' +
        'DESK_DepartmentMembers.ADDED_ON FROM DESK_DepartmentMembers ' +
        'INNER JOIN DESK_Departments ON DESK_DepartmentMembers.DEPARTMENT_REF = DESK_Departments.ROWID ' +
        'INNER JOIN Users ON DESK_DepartmentMembers.USER_REF = Users.ROWID ' +
        "WHERE Users.USER_ID = 'U-3005' ORDER BY DESK_Departments.DEPARTMENT_NAME",
    },
    {
      q: 'how many open tickets per department',
      zcql:
        'SELECT DESK_Departments.DEPARTMENT_NAME, COUNT(ROWID) FROM DESK_Tickets ' +
        'INNER JOIN DESK_Departments ON DESK_Tickets.DEPARTMENT_REF = DESK_Departments.ROWID ' +
        "WHERE DESK_Tickets.STATUS <> 'Closed' " +
        'GROUP BY DESK_Departments.DEPARTMENT_NAME ORDER BY COUNT(ROWID) DESC',
    },
  ],
};
