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
  },

  piiColumns: ['DESK_Tickets.CONTACT_EMAIL'],

  tables: [
    {
      name: 'DESK_Departments',
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
  ],

  commonQuestions: [
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
