'use strict';

/**
 * AskData client.
 *
 * Three things drive the design of this page.
 *
 * 1. CONNECTION STATE MUST BE UNMISTAKABLE. Querying the wrong customer's org
 *    is the worst failure mode this tool has, so the bar names the customer,
 *    goes green, and counts the grant down in view at all times. It turns amber
 *    under five minutes and locks the box when it expires.
 *
 * 2. COPY TO TICKET IS THE PRIMARY ACTION. The engineer's job is not to read a
 *    grid, it is to reply to the customer. So the ticket comment sits above the
 *    rows in its own block with the loudest button on the card, and the query
 *    is collapsed out of the reading path entirely.
 *
 * 3. NEVER SHOW A QUERY IN AN ERROR. A support engineer does not know SQL and
 *    must never need to. Refusals show the server's plain-English reason and a
 *    Send to debug engineer button; the ZCQL only ever appears behind "Show
 *    query", for the engineer who chooses to look and for the escalation.
 */

const API = '/server/askdata';
const SAVED = 'askdata.connection';
const INLINE_ROWS = 3;   // rows worth showing without a click
const ROWS_SHOWN = 50;

const el = (id) => document.getElementById(id);
const ui = {
  bar: el('conn-state'), org: el('conn-org'), meta: el('conn-meta'),
  timer: el('conn-timer'), countdown: el('conn-countdown'), disconnect: el('disconnect'),
  connectPanel: el('connect-panel'), connectForm: el('connect-form'), change: el('conn-change'),
  zgid: el('zgid'), zgids: el('zgids'), ticket: el('ticket'),
  connectGo: el('connect-go'), connectMsg: el('connect-msg'), detail: el('conn-detail'),
  askPanel: el('ask-panel'), question: el('question'), askBtn: el('ask-btn'),
  transcript: el('transcript'), starters: el('starters'), audit: el('audit'),
};

/** The one grant. Every request carries it; nothing carries an org id. */
const state = { token: null, org: null, expiresAt: null, ticket: null, timer: null };

/* ------------------------------------------------------------------ utils */

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** replaceChildren coerces null into the text "null" - filter first. */
function fill(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

/**
 * Who the server should treat as the engineer, when there is no Catalyst
 * sign-in to go on. Only ever populated from /health, and only outside
 * Production - the server ignores the header there regardless.
 */
let devEngineer = null;

async function api(path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (devEngineer) headers['X-AskData-Engineer'] = devEngineer;

  const res = await fetch(`${API}${path}`, body ? {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  } : { headers });
  const text = await res.text();
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 300) }; } }
  if (!res.ok && !parsed?.mode) {
    const err = new Error(parsed?.error || `Request failed (${res.status})`);
    err.body = parsed; err.status = res.status;
    throw err;
  }
  return parsed;
}

/* --------------------------------------------------------------- connect */

function setMsg(text, kind) {
  ui.connectMsg.textContent = text ?? '';
  ui.connectMsg.className = `msg${kind ? ` ${kind}` : ''}`;
}

function tick() {
  if (!state.expiresAt) return;
  const left = Math.max(0, Math.floor((state.expiresAt - Date.now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  ui.countdown.textContent = `${mm}:${ss}`;

  if (left === 0) {
    ui.bar.dataset.state = 'off';
    ui.meta.textContent = 'Grant expired — connect again';
    lockAsk('Your access expired. Connect again.');
    clearInterval(state.timer);
  } else if (left < 300) {
    ui.bar.dataset.state = 'expiring';
  }
}

function lockAsk(placeholder) {
  ui.askPanel.classList.add('locked');
  ui.question.disabled = true;
  ui.askBtn.disabled = true;
  ui.question.placeholder = placeholder;
}

function onConnected(r) {
  state.token = r.grant_token;
  state.org = r.org_name;
  state.ticket = r.ticket_id;
  state.expiresAt = Date.parse(r.expires_at);

  ui.bar.dataset.state = 'on';
  ui.org.textContent = r.org_name;
  ui.meta.textContent =
    `ZGID ${r.zgid} · ${String(r.dc).toUpperCase()} · ${r.products.join(', ')} · ticket ${r.ticket_id}`;
  ui.timer.hidden = false;
  ui.disconnect.hidden = false;
  ui.change.hidden = false;
  ui.connectPanel.classList.add('done');

  fill(ui.detail,
    h('span', { class: 'chip' }, h('b', { text: r.edition ?? '—' }), ' edition'),
    h('span', { class: 'chip' }, h('b', { text: String(r.queryable_tables) }), ' tables loaded'),
    h('span', { class: 'chip' }, h('b', { text: r.entitled_via }), ' entitlement'),
    h('span', { class: 'chip' }, h('b', { text: r.engineer.email }), ` (${r.engineer.identified_by})`)
  );
  ui.detail.hidden = false;

  ui.askPanel.classList.remove('locked');
  ui.question.disabled = false;
  ui.askBtn.disabled = false;
  ui.question.placeholder = "e.g. what's the source of lead 4551000000234017";
  ui.question.focus();

  setMsg(`Connected in ${r.latency_ms} ms.`, 'good');
  renderStarters(r.suggestions ?? []);
  localStorage.setItem(SAVED, JSON.stringify({ zgid: r.zgid, ticket: r.ticket_id }));

  clearInterval(state.timer);
  state.timer = setInterval(tick, 1000);
  tick();
  loadAudit();
}

function onDisconnected(message) {
  state.token = null; state.org = null; state.expiresAt = null;
  clearInterval(state.timer);
  ui.bar.dataset.state = 'off';
  ui.org.textContent = 'Not connected';
  ui.meta.textContent = 'Connect to a customer to begin';
  ui.timer.hidden = true;
  ui.disconnect.hidden = true;
  ui.change.hidden = true;
  ui.detail.hidden = true;
  lockAsk('Connect to a customer first…');
  setMsg(message ?? '', message ? 'bad' : null);
  fill(ui.starters, h('li', { class: 'dim small', text: 'Connect to see questions you can ask.' }));
}

async function connect() {
  const zgid = ui.zgid.value.trim();
  const ticket = ui.ticket.value.trim();
  if (!zgid || !ticket) {
    setMsg('Enter both the ZGID and the ticket you are working on.', 'bad');
    (zgid ? ui.ticket : ui.zgid).focus();
    return;
  }
  ui.connectGo.disabled = true;
  setMsg('Checking your entitlement…');
  try {
    onConnected(await api('/connect', { zgid, ticket_id: ticket }));
  } catch (err) {
    onDisconnected(err.message);
  } finally {
    ui.connectGo.disabled = false;
  }
}

/* ------------------------------------------------------------------ rows */

function cell(value, isPii) {
  if (value === null || value === undefined || value === '') return h('td', { class: 'nil', text: 'null' });
  if (value === true) return h('td', { text: 'true' });
  if (value === false) return h('td', { text: 'false' });
  const num = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)));
  return h('td', { class: `${num ? 'num' : ''}${isPii ? ' pii' : ''}`.trim() || null, text: String(value) });
}

/**
 * The grid, with per-row Reveal on the rows that have something masked.
 * Reveal is never offered for a whole column - the audit trail is the deterrent
 * and a bulk reveal makes it meaningless.
 */
function renderTable(result) {
  const { columns, rows, masked = [], highlights = [] } = result;
  if (!rows?.length || !columns?.length) return null;

  const flagged = new Map(highlights.map((x) => [x.row, x.why]));
  const shown = rows.slice(0, ROWS_SHOWN);
  const canReveal = masked.length > 0 && result.tables?.length === 1;

  const head = h('tr', {}, [
    ...columns.map((c) => h('th', { text: c.replace(/_/g, ' ').toLowerCase() })),
    flagged.size ? h('th', { text: 'note' }) : null,
    canReveal ? h('th', { text: '' }) : null,
  ]);

  const body = shown.map((row, i) => h('tr', { class: flagged.has(i) ? 'flagged' : null }, [
    ...columns.map((c) => cell(row[c], masked.includes(c))),
    flagged.size ? h('td', {}, h('span', { class: 'why', text: flagged.get(i) ?? '' })) : null,
    canReveal ? h('td', {}, h('button', {
      class: 'reveal-btn', type: 'button', text: 'Reveal',
      onclick: (e) => reveal(e.currentTarget, result.tables[0], row.ROWID, masked, row),
    })) : null,
  ]));

  const grid = h('div', {},
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), h('tbody', {}, body))),
    rows.length > shown.length
      ? h('p', { class: 'reveal-note', text: `Showing ${shown.length} of ${rows.length} rows.` })
      : null,
    canReveal
      ? h('p', { class: 'reveal-note', text: `${masked.join(', ')} masked. Revealing a row is logged against ticket ${state.ticket}.` })
      : masked.length
        ? h('p', { class: 'reveal-note', text: `${masked.join(', ')} masked. Reveal needs a single-table result.` })
        : null
  );

  // The summary is the answer; the grid is the evidence. A long list of rows
  // between the answer and the reply-for-the-customer buries both, so it folds
  // away - unless it is short, or unless a flagged row IS the answer, in which
  // case hiding it would hide the point.
  if (rows.length <= INLINE_ROWS || flagged.size) return grid;

  return h('details', { class: 'rows' },
    h('summary', { text: `Show underlying data (${rows.length} rows)` }),
    grid);
}

async function reveal(button, table, rowId, columns, row) {
  if (!rowId) { button.textContent = 'no row id'; return; }
  button.disabled = true;
  button.textContent = '…';
  try {
    const r = await api('/reveal', { grant_token: state.token, table, row_id: String(rowId), columns });
    const cells = [...button.closest('tr').querySelectorAll('td')];
    const headers = [...button.closest('table').querySelectorAll('thead th')].map((t) => t.textContent);
    for (const [col, value] of Object.entries(r.values)) {
      const idx = headers.indexOf(col.replace(/_/g, ' ').toLowerCase());
      if (idx >= 0 && cells[idx]) {
        cells[idx].textContent = String(value);
        cells[idx].classList.remove('nil');
      }
    }
    button.textContent = 'logged';
    loadAudit();
  } catch (err) {
    button.disabled = false;
    button.textContent = 'failed';
    console.warn(err);
  }
}

/* --------------------------------------------------------------- rendering */

function queryBlock(result) {
  if (!result.zcql) return null;
  const meta = [
    result.tables?.length ? `Tables: ${result.tables.join(', ')}` : null,
    result.org_scope ? `Tenant filter added automatically: ${result.org_scope}` : null,
    result.engine ? `Written by: ${result.engine}` : null,
    result.replica_source ? `Read: ${result.replica_source}` : null,
  ].filter(Boolean);

  return h('details', { class: 'query' },
    h('summary', { text: 'Show query' }),
    h('pre', { text: result.zcql }),
    meta.length ? h('p', { class: 'qmeta', text: meta.join(' · ') }) : null
  );
}

function ticketBlock(result) {
  if (!result.ticket_comment) return null;
  return h('div', { class: 'ticket' },
    h('span', { class: 'ticket-label', text: 'Reply for the customer' }),
    h('p', { class: 'ticket-text', text: result.ticket_comment }),
    h('div', { class: 'copy-row' },
      h('button', {
        class: 'copy-btn', type: 'button', text: 'Copy to ticket',
        onclick: async (e) => {
          try {
            await navigator.clipboard.writeText(result.ticket_comment);
            e.currentTarget.after(h('span', { class: 'copied', text: '✓ copied' }));
            e.currentTarget.textContent = 'Copied';
          } catch {
            // Clipboard can be blocked; selecting the text is the fallback.
            const r = document.createRange();
            r.selectNodeContents(e.currentTarget.closest('.ticket').querySelector('.ticket-text'));
            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
            e.currentTarget.textContent = 'Selected — press ⌘C';
          }
        },
      })
    )
  );
}

function escalateBlock(question, draft) {
  return h('div', { class: 'escalate' },
    h('p', { class: 'escalate-note', text: 'I could not answer this one. A debug engineer can, and I have drafted it.' }),
    h('div', { class: 'copy-row' },
      h('button', {
        class: 'btn-plain', type: 'button', text: 'Send to debug engineer',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = draft ?? await api('/escalate', { grant_token: state.token, question });
            await navigator.clipboard.writeText(r.ticket_comment).catch(() => {});
            e.currentTarget.textContent = 'Escalation copied';
            e.currentTarget.after(h('details', { class: 'query' },
              h('summary', { text: 'Show what was drafted' }),
              h('pre', { text: r.ticket_comment })));
          } catch (err) {
            e.currentTarget.textContent = 'Could not draft';
            console.warn(err);
          }
        },
      })
    )
  );
}

function renderAnswer(card, result, question) {
  card.className = 'card answered';
  const engineClass = String(result.engine ?? '').startsWith('model') ? 'tag-model' : 'tag-rules';

  fill(card,
    h('div', { class: 'card-head' },
      h('p', { class: 'summary', text: result.summary }),
      h('span', { class: `tag ${engineClass}`, text: String(result.engine ?? '').startsWith('model') ? 'model' : 'rules' }),
      h('span', { class: 'tag tag-ms', text: `${result.latency_ms} ms` }),
      h('span', { class: 'tag tag-asof', text: `as of ${String(result.as_of ?? '').slice(11, 16) || '—'}` })
    ),
    result.replica_lag_seconds > 60
      ? h('p', { class: 'freshness', text: `This read is about ${Math.round(result.replica_lag_seconds / 60)} minute(s) behind live.` })
      : null,
    // An unaudited answer has to look wrong. The engineer is about to paste it
    // into a customer-visible ticket on the strength of a trail that does not
    // exist.
    result.audit && result.audit.written === false
      ? h('p', { class: 'audit-gap', text: `Not recorded in the audit log — ${result.audit.error ?? 'the audit write failed'}` })
      : null,
    ticketBlock(result),
    renderTable(result),
    queryBlock(result)
  );
}

function renderClarify(card, result, question) {
  card.className = 'card clarify';
  const kids = [
    h('div', { class: 'card-head' },
      h('p', { class: 'summary', text: result.question }),
      h('span', { class: 'tag tag-rules', text: 'needs a choice' })
    ),
  ];

  if (result.candidates?.length) {
    kids.push(h('div', { class: 'candidates' }, result.candidates.map((c) =>
      h('div', { class: 'candidate' },
        h('b', { text: c.full_name ?? c.account_name ?? '—' }),
        c.email ? h('span', { class: 'pii', text: c.email }) : null,
        c.last_login ? h('span', { class: 'dim small', text: `last login ${String(c.last_login).slice(0, 16)}` }) : null,
        c.status ? h('span', { class: 'dim small', text: c.status }) : null,
        h('button', { class: 'btn-plain', type: 'button', text: 'This one', onclick: () => ask(c.suggestion) })
      ))));
  } else if (result.suggestions?.length) {
    kids.push(h('ul', { class: 'starters', style: 'padding:0 15px 12px' }, result.suggestions.slice(0, 6).map((s) =>
      h('li', {}, h('button', { type: 'button', text: s, onclick: () => ask(s) })))));
  }

  if (result.escalation_draft) kids.push(escalateBlock(question, result.escalation_draft));
  fill(card, kids);
}

function renderRefused(card, result, question) {
  card.className = 'card refused';
  fill(card,
    h('div', { class: 'card-head' },
      h('p', { class: 'summary', text: result.reason }),
      h('span', { class: 'tag tag-rules', text: 'refused' })
    ),
    result.suggestions?.length
      ? h('ul', { class: 'starters', style: 'padding:0 15px 12px' }, result.suggestions.slice(0, 5).map((s) =>
        h('li', {}, h('button', { type: 'button', text: s, onclick: () => ask(s) }))))
      : null,
    escalateBlock(question, result.escalation_draft)
  );
}

/* ------------------------------------------------------------------- ask */

let busy = false;

function newTurn(question) {
  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('span', { class: 'spinner' }), h('p', { class: 'summary', text: 'Looking…' })));
  const turn = h('div', { class: 'turn' }, h('div', { class: 'asked', text: question }), card);
  ui.transcript.prepend(turn);
  return card;
}

async function ask(question) {
  const q = String(question ?? '').trim();
  if (!q || busy) return;
  if (!state.token) { setMsg('Connect to a customer first.', 'bad'); ui.zgid.focus(); return; }

  busy = true;
  ui.askBtn.disabled = true;
  ui.question.value = '';
  const card = newTurn(q);

  try {
    const r = await api('/ask', { grant_token: state.token, question: q });
    if (r.mode === 'answer') renderAnswer(card, r, q);
    else if (r.mode === 'clarify') renderClarify(card, r, q);
    else renderRefused(card, r, q);

    if (r.grant?.seconds_left !== undefined) {
      state.expiresAt = Date.now() + r.grant.seconds_left * 1000;
      tick();
    }
    loadAudit();
    // "Where is the answer?" - the card renders below the connect panel and the
    // question box, which on a laptop viewport puts it under the fold. Bring it
    // to the top of the view rather than leaving the engineer to hunt for it.
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    renderRefused(card, { reason: err.message }, q);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } finally {
    busy = false;
    ui.askBtn.disabled = false;
    ui.question.focus();
  }
}

/* ----------------------------------------------------------------- panes */

function renderStarters(list) {
  fill(ui.starters, list.length
    ? list.map((s) => h('li', {}, h('button', { type: 'button', text: s, onclick: () => ask(s) })))
    : [h('li', { class: 'dim small', text: 'No starters for this customer.' })]);
}

async function loadAudit() {
  try {
    const { log } = await api('/audit?limit=40');
    fill(ui.audit, log.length
      ? log.map((r) => h('div', { class: `log ${r.OUTCOME}` },
        h('div', { class: 'q', text: r.QUESTION }),
        h('div', { class: 'm' },
          h('span', { class: 'badge', text: r.OUTCOME }),
          ` · ${r.ZGID} · ${r.TICKET_ID} · ${r.ROW_COUNT} rows · ${r.LATENCY_MS} ms`)))
      : [h('p', { class: 'dim small', text: 'Nothing logged yet.' })]);
  } catch {
    fill(ui.audit, h('p', { class: 'dim small', text: 'Audit log unavailable.' }));
  }
}

/* ------------------------------------------------------------------ init */

ui.connectForm.addEventListener('submit', (e) => { e.preventDefault(); connect(); });
ui.disconnect.addEventListener('click', () => onDisconnected(null));
ui.change.addEventListener('click', () => { ui.zgid.focus(); ui.zgid.select(); });
ui.askBtn.addEventListener('click', () => ask(ui.question.value));
ui.question.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(ui.question.value); }
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) {
      const on = t === tab;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
    }
    for (const p of document.querySelectorAll('.pane')) p.classList.toggle('on', p.id === tab.dataset.panel);
    if (tab.dataset.panel === 'p-audit') loadAudit();
  });
}

(async function boot() {
  // Ask the server who it will accept as an identity BEFORE anything else -
  // every later call depends on the header this sets.
  try {
    const health = await api('/health');
    if (health?.devIdentity?.allowed && health.devIdentity.engineer) {
      devEngineer = health.devIdentity.engineer;
      const badge = h('span', {
        class: 'dev-identity',
        text: `dev identity: ${devEngineer}`,
        title: 'No Catalyst sign-in on this page, so the server is told who you are by header. This is refused in Production.',
      });
      document.querySelector('.brand')?.append(badge);
    }
  } catch { /* the sign-in path still works; connect will say so */ }

  try {
    const { orgs } = await api('/orgs');
    fill(ui.zgids, orgs.map((o) => h('option', { value: o.ZGID, label: `${o.ORG_NAME} (${o.DC})` })));
  } catch { /* the field still accepts a typed ZGID, which is what matters */ }

  try {
    const saved = JSON.parse(localStorage.getItem(SAVED) || 'null');
    if (saved?.zgid) { ui.zgid.value = saved.zgid; ui.ticket.value = saved.ticket ?? ''; }
  } catch { /* ignore corrupt state */ }

  onDisconnected(null);
  ui.zgid.focus();
})();
