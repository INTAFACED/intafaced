import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { EDGE_PRINCIPAL_HEADER } from '@intafaced/contracts';
import {
  ACCOUNT_FROZEN,
  API_KEY_DENIED,
  API_KEY_EXPIRED,
  API_KEY_REVOKED,
  apiKeyRefusalBody,
  apiKeyRefusalFromIdentityCode,
  identityErrorCode,
} from './api-key-refusal.js';
import { scopeRefuseBody } from './gateway-plane.js';
import { exchangeApiKeyOutcome, exchangePrincipal } from './principal-exchange.js';
import { currentAuthorityTestReply } from './test-current-authority.js';

/**
 * DV-errors-02 at the edge: a presented `ifc_` key the edge cannot open is refused here with a stable code and
 * forwarded nowhere; identity not answering is a retryable 503, never a verdict on the key; an interactive JWT
 * still goes up as anonymous, as before.
 */

const tokens: TokenConfig = {
  secret: 'edge-test-jwt-signing-secret-32-chars',
  issuer: 'intafaced',
  audience: 'intafaced',
  accessTtlSeconds: 900,
};
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const options = {
  tokens,
  edgeSecret: 'edge-test-principal-secret-32-chars!',
  region: 'GB',
  identityUrl: 'http://identity.test',
  identityOwnershipSecret: 'edge-test-identity-authority-secret-32',
};
const KEY = 'ifc_presented_key_material_000000';

/** Identity's tRPC refusal, in the shape `toTrpcError` + the contracts formatter put on the wire. */
const identityRefusal = (status: number, intafacedCode?: string, wrapped = false) => {
  const error = {
    message: 'refused',
    code: -32009,
    data: { code: 'CONFLICT', httpStatus: status, ...(intafacedCode ? { intafacedCode } : {}) },
  };
  return async () => Response.json({ error: wrapped ? { json: error } : error }, { status });
};

interface AuthorityState {
  accountStatus?: string;
  credentialRevoked?: boolean;
  /** The credential identity knows; a different one than the token's is `auth.credential_denied`. */
  credentialId?: string;
  /** Answer the authority read with this denial code directly. */
  denial?: string;
}

async function opened(json: Record<string, unknown> = {}, authority: AuthorityState = {}): Promise<typeof fetch> {
  const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'], tier: 'basic', mfa: false }, tokens);
  return (async (input, init) => {
    if (authority.denial && String(input).endsWith('/trpc/accountControls.currentAuthority')) {
      const subject = JSON.parse(String(init?.body)) as unknown;
      return Response.json({
        result: { data: { status: 'denied', subject, checkedAt: new Date().toISOString(), code: authority.denial } },
      });
    }
    const reply = currentAuthorityTestReply(input, init, {
      expectedUserId: USER,
      expectedCredentialId: authority.credentialId ?? SESSION,
      ...(authority.accountStatus ? { accountStatus: authority.accountStatus } : {}),
      ...(authority.credentialRevoked ? { credentialRevoked: true } : {}),
    });
    if (reply) return reply;
    return Response.json({ result: { data: { json: { accessToken: issued.token, ...json } } } });
  }) as typeof fetch;
}

const present = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) =>
  exchangePrincipal({ authorization: `Bearer ${KEY}` }, { ...options, fetch, ...extra });

describe('a presented key the edge cannot open: refused here, with its own code', () => {
  it('a key identity does not recognise is edge.api_key_denied, carries no principal and is not marked for anonymous forwarding', async () => {
    const result = await present(identityRefusal(409, 'auth.invalid_credentials'));
    expect(result.apiKeyRefusal).toEqual(API_KEY_DENIED);
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('identity naming the key revoked is edge.api_key_revoked; expired is edge.api_key_expired; a frozen account is account_frozen', async () => {
    expect((await present(identityRefusal(403, 'auth.api_key_revoked'))).apiKeyRefusal).toEqual(API_KEY_REVOKED);
    const expired = await present(identityRefusal(401, 'auth.api_key_expired'));
    expect(expired.apiKeyRefusal).toEqual(API_KEY_EXPIRED);
    expect(expired.rejected).toBe('expired');
    expect((await present(identityRefusal(403, 'auth.account_frozen'))).apiKeyRefusal).toEqual(ACCOUNT_FROZEN);
    // The `{ json }` envelope and the `cause.code` copy are read the same way.
    expect((await present(identityRefusal(403, 'auth.api_key_revoked', true))).apiKeyRefusal).toEqual(API_KEY_REVOKED);
    const viaCause = async () =>
      Response.json({ error: { message: 'x', data: { code: 'FORBIDDEN', cause: { code: 'auth.account_frozen' } } } }, { status: 403 });
    expect((await present(viaCause)).apiKeyRefusal).toEqual(ACCOUNT_FROZEN);
  });

  it('every other verdict code on the key (restrictions, the caller’s request signature, an unknown account) is the one denied answer', async () => {
    for (const code of [
      'auth.domain_not_allowed',
      'auth.ip_not_allowed',
      'auth.ip_allowlist_required',
      'auth.product_outside',
      'auth.account_required',
      'auth.account_mismatch',
      'auth.account_denied',
      'auth.account_revoked',
      'auth.sub_account_denied',
      'auth.request_unsigned',
      'auth.request_stale',
      'auth.request_tampered',
      'auth.request_replay',
      'auth.not_found',
      'auth.api_key_denied',
    ]) {
      const result = await present(identityRefusal(401, code));
      expect(result.apiKeyRefusal, code).toEqual(API_KEY_DENIED);
      expect(result.rejected, code).toBe('invalid');
    }
  });

  it('a refusal caused by the edge’s own setup is unavailable (503), never "your key is bad"', async () => {
    const setup: Array<[string, typeof fetch]> = [
      ['404 for a path', (async () => new Response('Not Found', { status: 404 })) as typeof fetch],
      ['404 tRPC no such procedure', identityRefusal(404) as typeof fetch],
      ['400 for a body the edge built (no code)', identityRefusal(400) as typeof fetch],
      ['400 unparseable', (async () => new Response('<html>', { status: 400 })) as typeof fetch],
      ['400 product name the edge resolved', identityRefusal(400, 'auth.product_invalid') as typeof fetch],
      ['400 product widen', identityRefusal(400, 'auth.product_widen') as typeof fetch],
      ['401 with no verdict code', identityRefusal(401) as typeof fetch],
      ['401 service-auth code', identityRefusal(401, 'auth.service_unauthenticated') as typeof fetch],
      ['403 unknown code', identityRefusal(403, 'something.new') as typeof fetch],
    ];
    for (const [why, fetch] of setup) {
      const result = await present(fetch);
      expect(result.rejected, why).toBe('unavailable');
      expect(result.apiKeyRefusal, why).toBeUndefined();
      expect(result.principal, why).toBeNull();
    }
  });

  it('a key opened by identity but refused by the edge’s own checks: frozen status is account_frozen, the rest denied', async () => {
    expect((await present(await opened({ status: 'frozen' }))).apiKeyRefusal).toEqual(ACCOUNT_FROZEN);
    expect((await present(await opened({ status: 'closed' }))).apiKeyRefusal).toEqual(ACCOUNT_FROZEN);
    const past = new Date(Date.now() - 60_000).toISOString();
    const expired = await present(await opened({ expiresAt: past }));
    expect(expired.apiKeyRefusal).toEqual(API_KEY_EXPIRED);
    expect(expired.rejected).toBe('expired');
    const ipBound = await present(await opened({ ipAllowlist: ['203.0.113.7'] }), { clientIp: '198.51.100.9' });
    expect(ipBound.apiKeyRefusal).toEqual(API_KEY_DENIED);
    const originBound = await exchangePrincipal(
      { authorization: `Bearer ${KEY}`, origin: 'https://evil.example.net' },
      { ...options, fetch: await opened({ originAllowlist: ['https://app.example.com'] }) },
    );
    expect(originBound.apiKeyRefusal).toEqual(API_KEY_DENIED);
    const unsigned = await present(await opened({ requireSignature: true }));
    expect(unsigned.apiKeyRefusal).toEqual(API_KEY_DENIED);
  });

  it('a key opened but refused by the current-authority read is named from identity’s denial code', async () => {
    const frozen = await present(await opened({}, { accountStatus: 'frozen' }));
    expect(frozen.apiKeyRefusal).toEqual(ACCOUNT_FROZEN);
    expect(frozen.principal).toBeNull();
    expect((await present(await opened({}, { accountStatus: 'closed' }))).apiKeyRefusal).toEqual(ACCOUNT_FROZEN);
    expect((await present(await opened({}, { credentialRevoked: true }))).apiKeyRefusal).toEqual(API_KEY_REVOKED);
    expect((await present(await opened({}, { credentialId: '44444444-4444-4444-8444-444444444444' }))).apiKeyRefusal).toEqual(
      API_KEY_DENIED,
    );
    const expiredCredential = await present(await opened({}, { denial: 'auth.credential_expired' }));
    expect(expiredCredential.apiKeyRefusal).toEqual(API_KEY_EXPIRED);
  });

  it('a key-minted token whose ownership read says revoked is edge.api_key_revoked', async () => {
    const KID = '33333333-3333-4333-8333-333333333333';
    const issued = await issueAccessToken(
      { userId: USER, sessionId: KID, apiKeyId: KID, keyEnv: 'live', scopes: ['trade:read'], tier: 'basic', mfa: false },
      tokens,
    );
    const fetch = (async (input, init) => {
      const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: KID });
      if (authority) return authority;
      if (String(input).endsWith(`/internal/api-keys/${KID}`)) return Response.json({ id: KID, userId: USER, revoked: true });
      return Response.json({ result: { data: { json: { accessToken: issued.token } } } });
    }) as typeof globalThis.fetch;
    const result = await present(fetch);
    expect(result.apiKeyRefusal).toEqual(API_KEY_REVOKED);
    expect(result.principal).toBeNull();
  });

  it('a session (not a key) refused by the authority read carries no key refusal', async () => {
    const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'], tier: 'basic', mfa: false }, tokens);
    const fetch = (async (input, init) =>
      currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION, accountStatus: 'frozen' }) ??
      new Response('x', { status: 500 })) as typeof globalThis.fetch;
    const result = await exchangePrincipal({ authorization: `Bearer ${issued.token}` }, { ...options, fetch });
    expect(result.rejected).toBe('invalid');
    expect(result.apiKeyRefusal).toBeUndefined();
  });

  it('an opened key that passes every check is not refused', async () => {
    const result = await present(await opened());
    expect(result.apiKeyRefusal).toBeUndefined();
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
  });
});

describe('identity not answering is not a verdict on the key', () => {
  it.each([500, 502, 503, 408, 429])('identity HTTP %i is unavailable: no refusal code, no principal', async (status) => {
    const result = await present(identityRefusal(status, 'auth.invalid_credentials'));
    expect(result.rejected).toBe('unavailable');
    expect(result.apiKeyRefusal).toBeUndefined();
    expect(result.principal).toBeNull();
  });

  it('a network error, an unreadable 200 and a 200 with no token are unavailable', async () => {
    const answers: Array<typeof fetch> = [
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
      (async () => new Response('<html>', { status: 200 })) as typeof fetch,
      (async () => Response.json({ result: { data: { json: {} } } })) as typeof fetch,
    ];
    for (const fetch of answers) {
      const result = await present(fetch);
      expect(result.rejected).toBe('unavailable');
      expect(result.apiKeyRefusal).toBeUndefined();
    }
  });

  it('an edge with no identity configured is unavailable, not a denied key', async () => {
    const result = await exchangePrincipal({ authorization: `Bearer ${KEY}` }, { ...options, identityUrl: undefined });
    expect(result.rejected).toBe('unavailable');
    expect(result.apiKeyRefusal).toBeUndefined();
  });

  it('the exchange outcome: refused only with a verdict code, unavailable otherwise', async () => {
    expect(await exchangeApiKeyOutcome(KEY, 'http://identity.test', identityRefusal(503))).toEqual({ kind: 'unavailable' });
    expect(await exchangeApiKeyOutcome(KEY, 'http://identity.test', identityRefusal(403, 'auth.api_key_revoked'))).toEqual({
      kind: 'refused',
      identityCode: 'auth.api_key_revoked',
    });
    expect(await exchangeApiKeyOutcome(KEY, 'http://identity.test', identityRefusal(409))).toEqual({ kind: 'unavailable' });
    expect(await exchangeApiKeyOutcome(KEY, 'http://identity.test', identityRefusal(404))).toEqual({ kind: 'unavailable' });
  });
});

describe('what does not change', () => {
  it('a refused interactive JWT still goes up as anonymous, with no key refusal (it may need auth.refresh)', async () => {
    const result = await exchangePrincipal({ authorization: 'Bearer not.a.jwt' }, { ...options, fetch: identityRefusal(500) });
    expect(result.rejected).not.toBeNull();
    expect(result.apiKeyRefusal).toBeUndefined();
  });

  it('no bearer at all is anonymous and is the service’s to refuse (svc-trade: AuthenticationError / auth.required)', async () => {
    const result = await exchangePrincipal({}, { ...options, fetch: identityRefusal(500) });
    expect(result).toMatchObject({ principal: null, rejected: null });
    expect(result.apiKeyRefusal).toBeUndefined();
  });
});

describe('the body and the codes', () => {
  it('names the code, the identity code it came from, a message and the auth catalogue entry, and echoes nothing of the key', () => {
    for (const refusal of [API_KEY_DENIED, API_KEY_REVOKED, API_KEY_EXPIRED, ACCOUNT_FROZEN]) {
      const body = apiKeyRefusalBody(refusal);
      expect(body).toMatchObject({
        code: refusal.code,
        intafacedCode: refusal.intafacedCode,
        docs: `/developers/errors/auth#${refusal.code}`,
      });
      expect(body.message).toBe('You do not have access to this.');
      expect(JSON.stringify(body)).not.toContain(KEY);
    }
  });

  it('missing, wrong, revoked and out-of-scope keys give four distinct stable codes; credentials 401, restrictions 403', () => {
    const scope = scopeRefuseBody('trade', 'trade:write') as { code: string; intafacedCode: string };
    const codes = ['AuthenticationError' /* svc-trade, no key */, API_KEY_DENIED.code, API_KEY_REVOKED.code, scope.code];
    expect(new Set(codes).size).toBe(4);
    expect([API_KEY_DENIED.code, API_KEY_REVOKED.code, API_KEY_EXPIRED.code]).toEqual([
      'edge.api_key_denied',
      'edge.api_key_revoked',
      'edge.api_key_expired',
    ]);
    expect([API_KEY_DENIED.status, API_KEY_REVOKED.status, API_KEY_EXPIRED.status, ACCOUNT_FROZEN.status]).toEqual([401, 401, 401, 403]);
    // The freeze is identity's state, so it carries the catalogue name, not the gateway prefix.
    expect(ACCOUNT_FROZEN.code).toBe('account_frozen');
  });

  it('only three identity codes are told apart and nothing upstream is echoed', () => {
    expect(apiKeyRefusalFromIdentityCode('auth.api_key_revoked')).toBe(API_KEY_REVOKED);
    expect(apiKeyRefusalFromIdentityCode('auth.api_key_expired')).toBe(API_KEY_EXPIRED);
    expect(apiKeyRefusalFromIdentityCode('auth.account_frozen')).toBe(ACCOUNT_FROZEN);
    expect(apiKeyRefusalFromIdentityCode('edge.anything_upstream_said')).toBe(API_KEY_DENIED);
    expect(apiKeyRefusalFromIdentityCode(undefined)).toBe(API_KEY_DENIED);
  });

  it('identityErrorCode reads only a string code and ignores junk', () => {
    expect(identityErrorCode(null)).toBeUndefined();
    expect(identityErrorCode({ error: 'flat' })).toBeUndefined();
    expect(identityErrorCode({ error: { data: { intafacedCode: 7 } } })).toBeUndefined();
    expect(identityErrorCode({ error: { data: { intafacedCode: 'auth.x' } } })).toBe('auth.x');
    expect(identityErrorCode({ error: { json: { data: { cause: { code: 'auth.y' } } } } })).toBe('auth.y');
  });
});

describe('index.ts answers a key refusal before anonymous forwarding', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('refuses after the unavailable branch and before the anonymous log line, and sends the refusal body', () => {
    const unavailable = src.indexOf("exchanged.rejected === 'unavailable'");
    const refusal = src.indexOf('if (exchanged.apiKeyRefusal)');
    const anonymous = src.indexOf('token refused, forwarding anonymous');
    expect(unavailable).toBeGreaterThan(0);
    expect(refusal).toBeGreaterThan(unavailable);
    expect(anonymous).toBeGreaterThan(refusal);
    expect(src).toContain('reply.code(exchanged.apiKeyRefusal.status).send(apiKeyRefusalBody(exchanged.apiKeyRefusal))');
  });
});
