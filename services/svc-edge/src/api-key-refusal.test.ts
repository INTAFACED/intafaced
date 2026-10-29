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
import { exchangeApiKeyForAccessToken, exchangeApiKeyOutcome, exchangePrincipal } from './principal-exchange.js';
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

async function opened(json: Record<string, unknown> = {}, authority: { accountStatus?: string } = {}): Promise<typeof fetch> {
  const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'], tier: 'basic', mfa: false }, tokens);
  return (async (input, init) => {
    const reply = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION, ...authority });
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

  it('every other identity code, no code, and an unreadable 4xx body are the one denied answer', async () => {
    for (const code of [
      'auth.domain_not_allowed',
      'auth.ip_allowlist_required',
      'auth.request_tampered',
      'auth.not_found',
      'something.new',
      undefined,
    ]) {
      expect((await present(identityRefusal(409, code))).apiKeyRefusal, String(code)).toEqual(API_KEY_DENIED);
    }
    const garbled = async () => new Response('<html>', { status: 400 });
    expect((await present(garbled)).apiKeyRefusal).toEqual(API_KEY_DENIED);
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

  it('a key opened but refused by the current-authority read is denied: the edge names no reason identity did not give', async () => {
    const result = await present(await opened({}, { accountStatus: 'frozen' }));
    expect(result.apiKeyRefusal).toEqual(API_KEY_DENIED);
    expect(result.principal).toBeNull();
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

  it('the null-returning exchange keeps its contract; the outcome says which failure', async () => {
    expect(await exchangeApiKeyForAccessToken(KEY, 'http://identity.test', identityRefusal(503))).toBeNull();
    expect(await exchangeApiKeyForAccessToken(KEY, 'http://identity.test', identityRefusal(409, 'auth.invalid_credentials'))).toBeNull();
    expect(await exchangeApiKeyOutcome(KEY, 'http://identity.test', identityRefusal(503))).toEqual({ kind: 'unavailable' });
    expect(await exchangeApiKeyOutcome(KEY, 'http://identity.test', identityRefusal(403, 'auth.api_key_revoked'))).toEqual({
      kind: 'refused',
      identityCode: 'auth.api_key_revoked',
    });
    expect(await exchangeApiKeyOutcome(KEY, 'http://identity.test', identityRefusal(409))).toEqual({ kind: 'refused' });
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
      expect(typeof body.message).toBe('string');
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
