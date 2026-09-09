'use strict';

/**
 * Catalyst Connections adapter.
 *
 * Verified against zcatalyst-sdk-node 3.4.0 in the deployed runtime:
 *
 *   await app.connections().getConnectionCredentials('<linkName>')
 *     -> { headers: { Authorization: 'Zoho-oauthtoken <token>' }, parameters: {} }
 *
 * Note it returns ready-to-use *headers*, not an `access_token` field - which
 * is what the SDK reference implies. Reading `credentials.access_token` yields
 * undefined silently, and the request then fails as unauthenticated with
 * nothing pointing at the cause. We pass the headers straight through.
 *
 * The other documented form, `app.connection().getConnector(name)`, is the
 * legacy self-managed Connectors API: it demands client_id/client_secret in
 * code and cannot read a console-managed Connection. Do not use it here.
 */

const TTL_MS = 25 * 60 * 1000;

/** linkName -> { headers, parameters, expiresAt } */
const cache = new Map();

/**
 * Auth headers for a console-managed Connection.
 * Cached briefly so warm invocations do not re-fetch on every request.
 */
async function connectionHeaders(catalystApp, linkName) {
  const hit = cache.get(linkName);
  if (hit && Date.now() < hit.expiresAt) {
    return { headers: hit.headers, parameters: hit.parameters, cached: true };
  }

  if (!catalystApp || typeof catalystApp.connections !== 'function') {
    throw new Error(
      `Cannot resolve Connection "${linkName}": no Catalyst app with connections().`
    );
  }

  let creds;
  try {
    creds = await catalystApp.connections().getConnectionCredentials(linkName);
  } catch (err) {
    throw new Error(`Connection "${linkName}" lookup failed: ${err.message}`);
  }

  const headers = creds?.headers;
  if (!headers || !headers.Authorization) {
    throw new Error(
      `Connection "${linkName}" returned no Authorization header ` +
      `(got keys: ${creds ? Object.keys(creds).join(',') : 'nothing'}). ` +
      'Check the Connection exists and has been authorized in the console.'
    );
  }

  const entry = {
    headers,
    parameters: creds.parameters ?? {},
    expiresAt: Date.now() + TTL_MS,
  };
  cache.set(linkName, entry);
  return { headers: entry.headers, parameters: entry.parameters, cached: false };
}

/** Confirms a Connection resolves, reporting shape only - never token material. */
async function probeConnection(catalystApp, linkName) {
  try {
    const { headers, parameters, cached } = await connectionHeaders(catalystApp, linkName);
    const [scheme, token] = String(headers.Authorization).split(/\s+/);
    return {
      ok: true,
      cached,
      headerNames: Object.keys(headers),
      scheme,
      tokenLength: token?.length ?? 0,
      parameterNames: Object.keys(parameters),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { connectionHeaders, probeConnection };
