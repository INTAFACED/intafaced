import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { CurrentAuthorityInput } from '@intafaced/contracts';
import { authorityTimeoutFor } from './authority-timeout.js';
import { readEdgeAuthority, resetEdgeAuthorityState } from './live-authority.js';
import { exchangePrincipal } from './principal-exchange.js';

const userId = '11111111-1111-4111-8111-111111111111';
const sessionA = '22222222-2222-4222-8222-222222222222';
const sessionB = '44444444-4444-4444-8444-444444444444';
const tokens = { secret: 'synthetic-edge-jwt-secret-long-enough', issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };
const base = {
  tokens,
  edgeSecret: 'synthetic-edge-principal-key-long-enough',
  region: 'DE',
  identityUrl: 'http://identity.test',
  identityOwnershipSecret: 'synthetic-edge-private-read-secret-long-enough',
};

const eligible = (sessionId: string) => {
  const subject: CurrentAuthorityInput = { userId, credential: { kind: 'session', sessionId } };
  const now = new Date();
  return {
    status: 'eligible',
    subject,
    checkedAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 4000).toISOString(),
    account: { userId, status: 'active', kycTier: 'none' },
    credential: { kind: 'session', ownership: { id: sessionId, userId, revoked: false } },
    subAccount: null,
    version: '0',
  };
};
const denied = (sessionId: string) => ({
  status: 'denied',
  subject: { userId, credential: { kind: 'session', sessionId } },
  checkedAt: new Date().toISOString(),
  code: 'auth.credential_revoked',
});
async function session(sessionId = sessionA) {
  const issued = await issueAccessToken({ userId, sessionId, scopes: ['identity:read'], mfa: true, tier: 'full' }, tokens);
  return { token: issued.token, principal: await verifyAccessToken(issued.token, tokens) };
}

afterEach(() => {
  vi.useRealTimers();
  resetEdgeAuthorityState();
});

describe('identity cannot be asked: never anonymous, never a sign-out', () => {
  it('maps a timeout to rejected=unavailable, not invalid', async () => {
    const { token } = await session();
    vi.useFakeTimers();
    const pending = exchangePrincipal({ authorization: `Bearer ${token}` }, { ...base, fetch: () => new Promise<Response>(() => {}) });
    await vi.advanceTimersByTimeAsync(3001);
    const result = await pending;
    expect(result.rejected).toBe('unavailable');
    expect(result.principal).toBeNull();
  });

  it.each([500, 502, 503, 408, 429])('maps identity HTTP %i to unavailable', async (status) => {
    const { token } = await session();
    const result = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...base, fetch: async () => new Response('x', { status }) },
    );
    expect(result.rejected).toBe('unavailable');
    expect(result.principal).toBeNull();
  });

  it('maps a thrown network error and an unparseable body to unavailable', async () => {
    const { token } = await session();
    for (const fetcher of [
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => new Response('<html>', { status: 200 }),
    ]) {
      const result = await exchangePrincipal({ authorization: `Bearer ${token}` }, { ...base, fetch: fetcher as typeof fetch });
      expect(result.rejected).toBe('unavailable');
    }
  });

  it('keeps "identity said revoked" a refusal (401 downstream), including a 403 answer', async () => {
    const { token } = await session();
    const revoked = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...base, fetch: async () => Response.json({ result: { data: denied(sessionA) } }) },
    );
    expect(revoked.rejected).toBe('invalid');
    const forbidden = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...base, fetch: async () => new Response('no', { status: 403 }) },
    );
    expect(forbidden.rejected).toBe('invalid');
  });

  it('treats a key whose ownership read fails to connect as unavailable, and a 404 as refused', async () => {
    const keyId = '33333333-3333-4333-8333-333333333333';
    const issued = await issueAccessToken(
      { userId, sessionId: sessionA, scopes: ['identity:read'], mfa: true, tier: 'full', apiKeyId: keyId },
      tokens,
    );
    const principal = await verifyAccessToken(issued.token, tokens);
    const keyed: CurrentAuthorityInput = { userId, credential: { kind: 'api_key', apiKeyId: keyId } };
    const proof = {
      ...eligible(sessionA),
      subject: keyed,
      credential: { kind: 'api_key', ownership: { id: keyId, userId, revoked: false } },
    };
    const reply =
      (ownership: () => Response): typeof fetch =>
      async (url) =>
        String(url).includes('/trpc/') ? Response.json({ result: { data: proof } }) : ownership();
    const down = await readEdgeAuthority(principal, { ...base, fetch: reply(() => new Response('x', { status: 503 })) });
    expect(down.status).toBe('unavailable');
    const gone = await readEdgeAuthority(principal, { ...base, fetch: reply(() => new Response('x', { status: 404 })) });
    expect(gone.status).toBe('refused');
  });
});

describe('single flight per session', () => {
  it('shares ONE authority read between 5 parallel requests of the same session', async () => {
    const { principal } = await session();
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({ result: { data: eligible(sessionA) } });
    };
    const reads = await Promise.all(Array.from({ length: 5 }, () => readEdgeAuthority(principal, { ...base, fetch: fetcher })));
    expect(reads.every((read) => read.status === 'eligible')).toBe(true);
    expect(calls).toBe(1);
  });

  it('never shares a read between two sessions', async () => {
    const a = await session(sessionA);
    const b = await session(sessionB);
    let calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      calls += 1;
      const asked = JSON.parse(String(init?.body)) as { credential: { sessionId: string } };
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ result: { data: eligible(asked.credential.sessionId) } });
    };
    await Promise.all([
      readEdgeAuthority(a.principal, { ...base, fetch: fetcher }),
      readEdgeAuthority(b.principal, { ...base, fetch: fetcher }),
    ]);
    expect(calls).toBe(2);
  });

  it('does not reuse an answer after the read finished unless a cache window is passed', async () => {
    const { principal } = await session();
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return Response.json({ result: { data: eligible(sessionA) } });
    };
    await readEdgeAuthority(principal, { ...base, fetch: fetcher });
    await readEdgeAuthority(principal, { ...base, fetch: fetcher });
    expect(calls).toBe(2);
  });

  it('reuses a positive answer for at most 1 second, then a revoked session stops at the next read', async () => {
    const { principal } = await session();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    let revoked = false;
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return Response.json({ result: { data: revoked ? denied(sessionA) : eligible(sessionA) } });
    };
    // a huge window is clamped to 1000 ms, which is inside the 5000 ms revocation lease
    const options = { ...base, fetch: fetcher, positiveCacheMs: 60_000 };
    expect((await readEdgeAuthority(principal, options)).status).toBe('eligible');
    revoked = true;
    await vi.advanceTimersByTimeAsync(500);
    expect((await readEdgeAuthority(principal, options)).status).toBe('eligible');
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    expect((await readEdgeAuthority(principal, options)).status).toBe('refused');
    expect(calls).toBe(2);
    // a refusal is never cached
    revoked = false;
    expect((await readEdgeAuthority(principal, options)).status).toBe('eligible');
    expect(calls).toBe(3);
  });
});

describe('timeouts', () => {
  const env = { EDGE_AUTHORITY_STRICT_TIMEOUT_MS: 3000, EDGE_AUTHORITY_READ_TIMEOUT_MS: 8000 };
  it('keeps the strict cap for writes and money or security modules, the read cap only for non-money reads', () => {
    expect(authorityTimeoutFor('POST', 'support', env)).toBe(3000);
    expect(authorityTimeoutFor('GET', 'pay', env)).toBe(3000);
    expect(authorityTimeoutFor('GET', 'trade', env)).toBe(3000);
    expect(authorityTimeoutFor('GET', 'identity', env)).toBe(3000);
    expect(authorityTimeoutFor('GET', 'unknown-module', env)).toBe(3000);
    expect(authorityTimeoutFor('GET', 'support', env)).toBe(8000);
    expect(authorityTimeoutFor('HEAD', 'academy', env)).toBe(8000);
  });

  it('honours a higher cap: still waiting at 3 s, unavailable at 8 s', async () => {
    const { principal } = await session();
    vi.useFakeTimers();
    let settled: string | undefined;
    const pending = readEdgeAuthority(principal, { ...base, timeoutMs: 8000, fetch: () => new Promise<Response>(() => {}) }).then(
      (read) => {
        settled = read.status;
      },
    );
    await vi.advanceTimersByTimeAsync(3001);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(settled).toBe('unavailable');
  });
});

describe('edge answers 503 and keeps the session', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  it('answers 503 edge.authority_unavailable with Retry-After before it would forward anonymous', () => {
    const unavailable = src.indexOf("exchanged.rejected === 'unavailable'");
    const anonymous = src.indexOf('token refused, forwarding anonymous');
    expect(unavailable).toBeGreaterThan(0);
    expect(unavailable).toBeLessThan(anonymous);
    expect(src).toMatch(/\.code\(503\)\s*\.header\('retry-after', '1'\)/);
    expect(src).toContain("code: 'edge.authority_unavailable'");
  });
});
