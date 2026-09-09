'use strict';

/**
 * Session grants: the tenant boundary.
 *
 * A support engineer's Catalyst session belongs to Zoho. It has no customer org
 * of its own, and across one shift the engineer will legitimately query fifty
 * different customers. So the boundary cannot come from the session - it comes
 * from an explicit connect that produces a short-lived grant bound to
 * {engineer, zgid, ticket}.
 *
 * THE ORG_ID USED FOR SCOPING COMES FROM THE GRANT, NEVER FROM THE REQUEST
 * BODY. That is the point of signing it. `/ask` takes a `grant_token` and no
 * org of any kind; a tampered body has nothing to tamper with. The token is
 * HMAC-SHA256 signed and verified in constant time, so a forged or edited
 * token fails closed.
 *
 * ENGINEER IDENTITY. In production this is the Catalyst-authenticated user and
 * nothing else. `identifyEngineer` tries that first. Because this deployment
 * serves an unauthenticated demo client, it falls back to an
 * `X-AskData-Engineer` header - but ONLY in a non-Production environment, and
 * the source is recorded on the grant and in every audit row, so a reviewer can
 * always see which sessions were header-identified. Never enable that fallback
 * in Production: it would let anyone name themselves as any engineer.
 */

const crypto = require('node:crypto');

const TTL_SECONDS = Number(process.env.ASKDATA_GRANT_TTL_SECONDS || 30 * 60);
const RENEW_WITHIN_SECONDS = 10 * 60;

class GrantError extends Error {
  constructor(message, { status = 403, code = 'grant_invalid', security = false } = {}) {
    super(message);
    this.name = 'GrantError';
    this.status = status;
    this.code = code;
    this.security = security;
  }
}

function secret() {
  const s = process.env.ASKDATA_GRANT_SECRET;
  if (!s || s.length < 16) {
    throw new GrantError(
      'AskData is misconfigured: no grant signing secret.',
      { status: 500, code: 'no_secret' }
    );
  }
  return s;
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (str) => Buffer.from(str, 'base64url');

function sign(payloadJson) {
  return b64(crypto.createHmac('sha256', secret()).update(payloadJson).digest());
}

/** Issue a grant. `payload` must already have been authorised by `entitlement`. */
function issue({ engineer, org, ticketId, service = 'all', serviceOrgId = null }) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    eid: engineer.id,
    email: engineer.email,
    src: engineer.source,
    zgid: org.ZGID,
    org: org.ORG_ID,
    dc: org.DC,
    products: String(org.SUBSCRIBED_PRODUCTS ?? ''),
    ticket: String(ticketId),
    // The service the engineer picked, and the id they actually typed. Both are
    // signed: which service a session may read is a scope decision, so it
    // belongs in the grant next to the tenant and never in a request body.
    service: String(service ?? 'all'),
    svcid: serviceOrgId ? String(serviceOrgId) : null,
    iat: now,
    exp: now + TTL_SECONDS,
  };
  const body = JSON.stringify(claims);
  return {
    token: `${b64(body)}.${sign(body)}`,
    claims,
    expires_at: new Date(claims.exp * 1000).toISOString(),
  };
}

/**
 * Verify a token and return its claims.
 *
 * Compared with `timingSafeEqual` on equal-length buffers - a plain `===` on
 * an HMAC is a textbook timing oracle.
 */
function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new GrantError('Connect to a customer before asking anything.', { code: 'no_grant' });
  }
  const [bodyPart, sigPart] = token.split('.', 2);
  let body;
  try {
    body = unb64(bodyPart).toString('utf8');
    JSON.parse(body);
  } catch {
    throw new GrantError('That connection is not valid. Connect again.', { code: 'malformed', security: true });
  }

  const expected = Buffer.from(sign(body));
  const given = Buffer.from(String(sigPart));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    // A bad signature is a tampered or forged grant, not a typo.
    throw new GrantError('That connection is not valid. Connect again.', {
      code: 'bad_signature',
      security: true,
    });
  }

  const claims = JSON.parse(body);
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    throw new GrantError('Your 30-minute access to this customer has expired. Connect again.', {
      code: 'expired',
      status: 401,
    });
  }

  return {
    engineerId: claims.eid,
    engineerEmail: claims.email,
    identitySource: claims.src,
    zgid: claims.zgid,
    orgId: claims.org,
    dc: claims.dc,
    products: claims.products,
    ticketId: claims.ticket,
    service: claims.service ?? 'all',
    serviceOrgId: claims.svcid ?? null,
    issuedAt: claims.iat,
    expiresAt: claims.exp,
    secondsLeft: claims.exp - now,
    renewable: claims.exp - now < RENEW_WITHIN_SECONDS,
  };
}

/**
 * Who is asking.
 *
 * Catalyst's authenticated user is the only acceptable answer in Production.
 * The header fallback exists so the demo client can run unauthenticated, and it
 * is refused outright when `ASKDATA_ENV` is Production.
 */
async function identifyEngineer(catalystApp, req) {
  try {
    const user = await catalystApp.userManagement().getCurrentUser();
    if (user?.user_id) {
      return {
        id: String(user.user_id),
        email: user.email_id ?? `${user.user_id}@zohocorp.com`,
        name: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Support engineer',
        source: 'catalyst_auth',
      };
    }
  } catch {
    // Not signed in to Catalyst; fall through.
  }

  const header = req.get('x-askdata-engineer');
  if (header && process.env.ASKDATA_ENV !== 'Production') {
    const email = String(header).trim().slice(0, 200);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new GrantError('X-AskData-Engineer must be an email address.', { status: 400, code: 'bad_engineer' });
    }
    return { id: `hdr:${email}`, email, name: email.split('@')[0], source: 'dev_header' };
  }

  throw new GrantError(
    'Sign in before connecting to a customer.',
    { status: 401, code: 'not_authenticated' }
  );
}

module.exports = { issue, verify, identifyEngineer, GrantError, TTL_SECONDS };
