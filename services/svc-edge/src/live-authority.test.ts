import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueAccessToken, verifyAccessToken, type Principal } from '@intafaced/auth';
import { verifyServiceHeaders, type CurrentAuthorityInput } from '@intafaced/contracts';
import {
  AUTHORITY_LEASE_SLA_MS,
  AUTHORITY_POSITIVE_CACHE_MS,
  AUTHORITY_RETRY_AFTER_SECONDS,
  authorityTimeoutFor,
  authorityUnavailableHttp,
  readEdgeAuthority,
  resetEdgeAuthorityCoalescing,
} from './live-authority.js';
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
afterEach(() => {
  vi.useRealTimers();
  resetEdgeAuthorityCoalescing();
});

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
  it('refuses session and key JWTs before any identity read when the ownership secret is blank', async () => {
    for (const key of [undefined, keyId]) {
      const { token } = await bearer(key);
      for (const blank of [undefined, '', ' ', ' '.repeat(32), '\t\n'.repeat(32)]) {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: { data: eligible() } }));
        const result = await exchangePrincipal(
          { authorization: `Bearer ${token}` },
          { ...base, identityOwnershipSecret: blank, fetch: fetcher },
        );
        expect(result.principal).toBeNull();
        expect(result.rejected).toBe('invalid');
        expect(fetcher).not.toHaveBeenCalled();
      }
    }
  });
  it('rejects revoked proofs as ineligible and does not cache a denial', async () => {
    const { principal } = await bearer();
    const denied = { status: 'denied', subject, checkedAt: new Date().toISOString(), code: 'auth.credential_revoked' };
    expect(await readEdgeAuthority(principal, { ...base, fetch: async () => Response.json({ result: { data: denied } }) })).toEqual({
      status: 'ineligible',
    });
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return Response.json({ result: { data: denied } });
    };
    expect(await readEdgeAuthority(principal, { ...base, fetch: fetcher })).toEqual({ status: 'ineligible' });
    expect(await readEdgeAuthority(principal, { ...base, fetch: fetcher })).toEqual({ status: 'ineligible' });
    expect(calls).toBe(2);
  });
  it('treats a stale, wrapped, foreign, or malformed proof as unavailable, not a revoke', async () => {
    const { principal } = await bearer();
    for (const proof of [
      { ...eligible(), checkedAt: '2020-01-01T00:00:00.000Z', leaseExpiresAt: '2020-01-01T00:00:05.000Z' },
      { json: eligible() },
      eligible({ userId: keyId, credential: { kind: 'session', sessionId } }),
      { status: 'eligible' },
      { status: 'unavailable', subject, checkedAt: new Date().toISOString(), code: 'authority.unavailable' },
    ])
      expect(
        await readEdgeAuthority(principal, { ...base, fetch: async () => Response.json({ result: { data: proof } }) }),
      ).toEqual({ status: 'unavailable' });
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
      expect(await pending).toEqual({ status: 'unavailable' });
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
    expect(await readEdgeAuthority(principal, policy)).toMatchObject({ status: 'eligible' });
    for (const wrong of [{ clientIp: '192.0.2.1' }, { origin: 'https://foreign.example' }, { product: 'pay' }])
      expect(await readEdgeAuthority(principal, { ...policy, ...wrong })).toEqual({ status: 'ineligible' });
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
      ).toEqual({ status: 'ineligible' });
  });
});

const revokedProof = {
  status: 'denied' as const,
  subject,
  checkedAt: new Date().toISOString(),
  code: 'auth.credential_revoked' as const,
};

describe('identity authority availability', () => {
  it('answers 503 edge.authority_unavailable when identity times out, and does not forward a principal', async () => {
    const { token } = await bearer();
    vi.useFakeTimers();
    const pending = exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...base, fetch: () => new Promise<Response>(() => undefined) },
    );
    await vi.advanceTimersByTimeAsync(3_001);
    const result = await pending;
    expect(result.principal).toBeNull();
    expect(result.rejected).toBe('unavailable');
    expect(result.headers['x-intafaced-principal']).toBeUndefined();
    expect(authorityUnavailableHttp(result.rejected)).toEqual({
      status: 503,
      code: 'edge.authority_unavailable',
      retryAfterSeconds: AUTHORITY_RETRY_AFTER_SECONDS,
    });
  });

  it('answers 503 when identity returns 500 or the network fails', async () => {
    const { token } = await bearer();
    for (const fetchImpl of [
      async () => new Response('down', { status: 500 }),
      async () => {
        throw new Error('econnreset');
      },
    ] as Array<typeof fetch>) {
      const result = await exchangePrincipal({ authorization: `Bearer ${token}` }, { ...base, fetch: fetchImpl });
      expect(result.principal).toBeNull();
      expect(result.rejected).toBe('unavailable');
      expect(authorityUnavailableHttp(result.rejected)?.status).toBe(503);
    }
  });

  it('still refuses 401 when identity says the session is revoked', async () => {
    const { token } = await bearer();
    const result = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...base, fetch: async () => Response.json({ result: { data: revokedProof } }) },
    );
    expect(result.principal).toBeNull();
    expect(result.rejected).toBe('invalid');
    expect(authorityUnavailableHttp(result.rejected)).toBeNull();
  });

  it('coalesces five parallel requests of one session into one authority call, and not a second session', async () => {
    const { principal } = await bearer();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher: typeof fetch = async (_url, init) => {
      calls += 1;
      await gate;
      const input = JSON.parse(String(init?.body)) as typeof subject;
      return Response.json({ result: { data: eligible(input) } });
    };
    const read = (who: Principal) =>
      readEdgeAuthority(who, { ...base, fetch: fetcher, positiveCacheMs: AUTHORITY_POSITIVE_CACHE_MS });
    const five = Promise.all(Array.from({ length: 5 }, () => read(principal)));
    expect(calls).toBe(1);
    release();
    expect((await five).every((result) => result.status === 'eligible')).toBe(true);
    expect(calls).toBe(1);
    const other: Principal = { ...principal, sid: '44444444-4444-4444-8444-444444444444' };
    expect((await read(other)).status).toBe('eligible');
    expect(calls).toBe(2);
    expect((await read(principal)).status).toBe('eligible');
    expect(calls).toBe(2);
  });

  it('stops a revoked session within the 5000ms lease and does not cache the denial', async () => {
    const { principal } = await bearer();
    vi.useFakeTimers();
    let revoked = false;
    const fetcher = vi.fn(async () =>
      Response.json({
        result: {
          data: revoked ? { ...revokedProof, checkedAt: new Date().toISOString() } : eligible(),
        },
      }),
    );
    const read = () => readEdgeAuthority(principal, { ...base, fetch: fetcher, positiveCacheMs: AUTHORITY_POSITIVE_CACHE_MS });
    expect(await read()).toMatchObject({ status: 'eligible' });
    revoked = true;
    expect(await read()).toMatchObject({ status: 'eligible' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTHORITY_POSITIVE_CACHE_MS);
    expect(AUTHORITY_POSITIVE_CACHE_MS).toBeLessThanOrEqual(2_000);
    expect(AUTHORITY_POSITIVE_CACHE_MS).toBeLessThan(AUTHORITY_LEASE_SLA_MS);
    expect(await read()).toEqual({ status: 'ineligible' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    revoked = false;
    expect(await read()).toMatchObject({ status: 'eligible' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('uses an 8s cap for non-money reads and keeps 3s for money, security, and writes', async () => {
    expect(authorityTimeoutFor({ method: 'GET', module: 'pay' })).toBe(3_000);
    expect(authorityTimeoutFor({ method: 'POST', module: 'academy' })).toBe(3_000);
    expect(authorityTimeoutFor({ method: 'GET', module: 'identity' })).toBe(3_000);
    expect(authorityTimeoutFor({ method: 'GET', module: 'academy' })).toBe(8_000);
    expect(authorityTimeoutFor({ method: 'HEAD', module: 'protocol' })).toBe(8_000);
    const { principal } = await bearer();
    vi.useFakeTimers();
    const fetcher: typeof fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return Response.json({ result: { data: eligible() } });
    };
    const pending = readEdgeAuthority(principal, {
      ...base,
      fetch: fetcher,
      timeoutMs: authorityTimeoutFor({ method: 'GET', module: 'academy' }),
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await pending).toMatchObject({ status: 'eligible' });
  });

  it('refuses at the proxy with Retry-After before an anonymous forward', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const held = src.indexOf('authorityUnavailableHttp(');
    const anonymous = src.indexOf('forwarding anonymous');
    const upstream = src.indexOf('fetch(`${resolved.base}');
    expect(held).toBeGreaterThan(0);
    expect(anonymous).toBeGreaterThan(held);
    expect(upstream).toBeGreaterThan(anonymous);
    expect(src).toContain(".header('retry-after'");
  });
});
