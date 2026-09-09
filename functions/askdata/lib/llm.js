'use strict';

/**
 * QuickML LLM Serving client (GLM-4.7-Flash).
 *
 * The REQUEST is OpenAI chat-completions shaped. The RESPONSE is not: the live
 * API returns a flat `{ response, usage }` object, despite the console's own
 * "Sample Response" showing `choices[].message.content`. Both are handled,
 * because the console sample is what you would code against if you trusted it.
 *
 * Two more behaviours worth knowing before changing anything here:
 *
 *  - The model emits visible chain-of-thought by default, terminated by a
 *    literal `</think>`. That burns most of the token budget before it reaches
 *    the answer, and the reasoning contains its own fenced code block - so a
 *    naive fence match grabs a decoy. `enable_thinking: false` is the default
 *    below; `stripThinking` runs anyway, defensively.
 *
 *  - Its guardrail misfires on phrasings like "Return ONLY this, no other
 *    text", refusing as though it were a prompt-extraction attempt. Ask for the
 *    output shape positively instead.
 */

const { connectionHeaders } = require('./connection');

const DEFAULT_MODEL = 'crm-di-glm47b_30b_it';
const CONNECTION_LINK_NAME = process.env.QUICKML_CONNECTION_NAME || "quickmlcon";

/**
 * `CATALYST_*` is a reserved env prefix we cannot set ourselves, but the
 * runtime injects some of those names. Prefer our own ASKDATA_* values and fall
 * back to whatever Catalyst provides.
 */
function orgId() {
  return process.env.ASKDATA_ORG_ID || process.env.CATALYST_ORG_ID || null;
}

/**
 * The QuickML endpoint is project-scoped. It is deliberately separate from the
 * project holding the Data Store: GLM serving has to be provisioned per
 * project, so pointing this at an already-working project is the difference
 * between a demo that answers questions and one that only ever falls back.
 */
function llmProjectId() {
  return (
    process.env.ASKDATA_QUICKML_PROJECT_ID ||
    process.env.ASKDATA_PROJECT_ID ||
    process.env.CATALYST_PROJECT_ID ||
    null
  );
}

function endpoint() {
  if (process.env.QUICKML_ENDPOINT) return process.env.QUICKML_ENDPOINT;
  const project = llmProjectId();
  if (!project) {
    throw new Error('Set QUICKML_ENDPOINT, or ASKDATA_QUICKML_PROJECT_ID so it can be derived.');
  }
  return `https://api.catalyst.zoho.com/quickml/v1/project/${project}/glm/chat`;
}

/** QuickML needs QuickML.deployment.READ, hence its own Connection. */
async function quickmlHeaders(catalystApp) {
  if (process.env.QUICKML_ACCESS_TOKEN) {
    return { Authorization: `Zoho-oauthtoken ${process.env.QUICKML_ACCESS_TOKEN}` };
  }
  const { headers } = await connectionHeaders(catalystApp, CONNECTION_LINK_NAME);
  return headers;
}

/**
 * One chat completion. Returns the assistant message as a string.
 * Throws with the response body attached so callers can log something useful.
 */
async function chat(catalystApp, messages, opts = {}) {
  const auth = await quickmlHeaders(catalystApp);
  const org = orgId();
  if (!org) throw new Error('ASKDATA_ORG_ID is required for the CATALYST-ORG header.');

  const body = {
    model: opts.model || process.env.QUICKML_MODEL || DEFAULT_MODEL,
    messages,
    max_tokens: opts.maxTokens ?? 400,
    temperature: opts.temperature ?? 0,
    stream: false,
    chat_template_kwargs: { enable_thinking: opts.thinking === true },
  };

  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { ...auth, 'CATALYST-ORG': org, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }

  if (!res.ok) {
    const err = new Error(`QuickML chat failed with ${res.status}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }

  const content =
    typeof parsed?.response === 'string'
      ? parsed.response
      : parsed?.choices?.[0]?.message?.content;

  if (typeof content !== 'string') {
    const err = new Error(
      `QuickML returned no assistant content (keys: ${parsed ? Object.keys(parsed).join(',') : 'none'})`
    );
    err.body = parsed;
    throw err;
  }

  if (parsed?.usage) {
    console.log(
      `QuickML usage: prompt=${parsed.usage.prompt_tokens} completion=${parsed.usage.completion_tokens}`
    );
  }

  return stripThinking(content);
}

/** Drop any chain-of-thought preamble, keeping only what follows `</think>`. */
function stripThinking(text) {
  if (typeof text !== 'string') return text;
  const close = text.lastIndexOf('</think>');
  return close === -1 ? text : text.slice(close + '</think>'.length).trim();
}

module.exports = {
  chat,
  stripThinking,
  endpoint,
  orgId,
  llmProjectId,
  quickmlHeaders,
  DEFAULT_MODEL,
  CONNECTION_LINK_NAME,
};
