import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueAccessToken, verifyAccessToken, type Principal } from '@intafaced/auth';
import { verifyServiceHeaders, type CurrentAuthorityInput } from '@intafaced/contracts';
import { readEdgeAuthority } from './live-authority.js';
import { exchangePrincipal } from './principal-exchange.js';

const userId = '11111111-1111-4111-8111-111111111111',
  sessionId = '22222222-2222-4222-8222-222222222222',
  keyId = '33333333-3333-4333-8333-333333333333';
const tokens = { secret: 'synthetic-edge-jwt-secret-long-enough', issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };
const secret = 'synthetic-edge-private-read-secret-long-enough';
const base = {
  tokens,
  edgeSecret: 'synthetic-edge-principal-key-long-enough',
  region: 'DE',
  identityUrl: 'http://identity.test',
  identityOwnershipSecret: secret,
};
const subject: CurrentAuthorityInput = { userId, credential: { kind: 'session', sessionId } };
const eligible = (input = subject) => {
  const checkedAt = new Date();
  return {
    status: 'eligible',
    subject: input,
    checkedAt: checkedAt.toISOString(),
    leaseExpiresAt: new Date(checkedAt.getTime() + 4000).toISOString(),
    account: { userId: input.userId, status: 'active', kycTier: 'none' },
    credential: {
      kind: input.credential.kind,
      ownership: {
        id: input.credential.kind === 'session' ? input.credential.sessionId : input.credential.apiKeyId,
        userId: input.userId,
        revoked: false,
      },
    },
    subAccount: null,
    version: '0',
  };
};
async function bearer(apiKeyId?: string) {
  const issued = await issueAccessToken(
    { userId, sessionId, scopes: ['identity:read', 'ops:read', 'ops:write'], mfa: true, tier: 'full', ...(apiKeyId ? { apiKeyId } : {}) },
    tokens,
  );
  return { token: issued.token, principal: await verifyAccessToken(issued.token, tokens) };
}
afterEach(() => vi.useRealTimers());

describe('HTTP perimeter current identity authority', () => {
  it('forwards a real TOTP-style MFA session using only actual authority fields and a body-bound read key', async () => {
    const { token } = await bearer();
    const calls: string[] = [];
    const result = await exchangePrincipal(
      { authorization: `Bearer ${token}`, 'x-intafaced-client-ip': '192.0.2.99', 'x-forwarded-for': '192.0.2.99' },
      {
        ...base,
        clientIp: '203.0.113.8',
        fetch: async (url, init) => {
          calls.push(String(url));
          expect(String(url)).toBe('http://identity.test/trpc/accountControls.currentAuthority');
          expect(init?.method).toBe('POST');
          expect(init?.redirect).toBe('error');
          expect(new Headers(init?.headers).get('cache-control')).toBe('no-store');
          expect(
            verifyServiceHeaders(Object.fromEntries(new Headers(init?.headers)), secret, {
              mode: 'require',
              rawBody: { retained: true, bytes: Buffer.from(String(init?.body)) },
            }).service,
          ).toBe('svc-edge');
          expect(JSON.parse(String(init?.body))).toEqual(subject);
          return Response.json({ result: { data: eligible() } });
        },
      },
    );
    expect(result.principal).toMatchObject({ userId, mfa: true, tier: 'none' });
    expect(result.headers['x-intafaced-client-ip']).toBe('203.0.113.8');
    expect(calls).toHaveLength(1);
  });
  it('refuses a valid JWT without live configuration, while retaining anonymous intake and trusted IP', async () => {
    const { token } = await bearer();
    for (const missing of [{ identityOwnershipSecret: undefined }, { identityUrl: undefined }]) {
      expect((await exchangePrincipal({ authorization: `Bearer ${token}` }, { ...base, ...missing })).principal).toBeNull();
    }
    const anonymous = await exchangePrincipal(
      { 'x-intafaced-client-ip': 'forged' },
      { ...base, identityOwnershipSecret: undefined, clientIp: '127.0.0.1' },
    );
    expect(anonymous.rejected).toBeNull();
    expect(anonymous.headers['x-intafaced-client-ip']).toBe('127.0.0.1');
  });
  it('rejects revoked, stale, wrapped, foreign-subject or malformed proofs without positive caching', async () => {
    const { principal } = await bearer();
    for (const proof of [
      { status: 'denied', subject, checkedAt: new Date().toISOString(), code: 'auth.credential_revoked' },
      { ...eligible(), checkedAt: '2020-01-01T00:00:00.000Z', leaseExpiresAt: '2020-01-01T00:00:05.000Z' },
      { json: eligible() },
      eligible({ userId: keyId, credential: { kind: 'session', sessionId } }),
      { status: 'eligible' },
    ])
      expect(await readEdgeAuthority(principal, { ...base, fetch: async () => Response.json({ result: { data: proof } }) })).toBeNull();
    let active = true;
    const fetcher: typeof fetch = async () =>
      Response.json({
        result: {
          data: active ? eligible() : { status: 'denied', subject, checkedAt: new Date().toISOString(), code: 'auth.account_frozen' },
        },
      });
    expect(await readEdgeAuthority(principal, { ...base, fetch: fetcher })).not.toBeNull();
    active = false;
    expect(await readEdgeAuthority(principal, { ...base, fetch: fetcher })).toBeNull();
  });
  it('bounds both stuck transport and stuck response bodies even if abort is ignored', async () => {
    const { principal } = await bearer();
    vi.useFakeTimers();
    for (const fetcher of [
      async () => new Promise<Response>(() => {}),
      async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response,
    ]) {
      const pending = readEdgeAuthority(principal, { ...base, fetch: fetcher });
      await vi.advanceTimersByTimeAsync(3001);
      expect(await pending).toBeNull();
    }
  });
  it('preserves actual API-key IP/origin/account/expiry and server-resolved product restrictions', async () => {
    const { token, principal } = await bearer(keyId);
    const keyed: CurrentAuthorityInput = { userId, credential: { kind: 'api_key', apiKeyId: keyId } };
    const metadata = {
      id: keyId,
      userId,
      revoked: false,
      ipAllowlist: ['203.0.113.8'],
      originAllowlist: ['https://join.example'],
      productScopes: ['trade'],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const fetcher: typeof fetch = async (url) =>
      Response.json(String(url).includes('/trpc/') ? { result: { data: eligible(keyed) } } : metadata);
    const policy = { ...base, clientIp: '203.0.113.8', origin: 'https://join.example', product: 'trade', fetch: fetcher };
    expect(await readEdgeAuthority(principal, policy)).not.toBeNull();
    for (const wrong of [{ clientIp: '192.0.2.1' }, { origin: 'https://foreign.example' }, { product: 'pay' }])
      expect(await readEdgeAuthority(principal, { ...policy, ...wrong })).toBeNull();
    expect(
      (
        await exchangePrincipal(
          { authorization: `Bearer ${token}`, 'x-product': 'trade', origin: 'https://join.example' },
          { ...policy, resolvedProduct: 'pay' },
        )
      ).principal,
    ).toBeNull();
    for (const altered of [
      { ...metadata, revoked: true },
      { ...metadata, accountId: sessionId },
      { ...metadata, expiresAt: new Date(0).toISOString() },
    ])
      expect(
        await readEdgeAuthority(principal, {
          ...policy,
          fetch: async (url) => Response.json(String(url).includes('/trpc/') ? { result: { data: eligible(keyed) } } : altered),
        }),
      ).toBeNull();
  });
});
