import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { issueAccessToken, verifyAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { verifyForwardedPrincipal } from '@intafaced/contracts';
import { createAdminApi } from './admin-api.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { registerAdminRoutes } from './control-plane.js';
import { KillSwitchState } from './kill-switch.js';
import { httpMatchingOperator, type MatchingOperatorCall } from './matching-operator-door.js';

const tokens: TokenConfig = {
  secret: 'test-only-signing-secret-at-least-32-characters-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const EDGE_SECRET = 'edge-principal-secret-at-least-32-characters';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const APPROVER = '44444444-4444-4444-8444-444444444444';

async function bearer(scopes: string[], mfa = true): Promise<string> {
  const { token } = await issueAccessToken({ userId: OPERATOR, sessionId: SESSION, scopes, tier: 'institutional', mfa }, tokens);
  return `Bearer ${token}`;
}

async function founder(scopes: string[], mfa = true): Promise<Principal> {
  const { token } = await issueAccessToken({ userId: OPERATOR, sessionId: SESSION, scopes, tier: 'institutional', mfa }, tokens);
  return verifyAccessToken(token, tokens);
}

function admin() {
  return createAdminApi(new KillSwitchState(), { tokens, ledger: null, approvals: stubApprovalConsumer(APPROVER) });
}

describe('edge founder matching door', () => {
  it('refuses when matching is unwired and does not publish a book count', async () => {
    const app = Fastify({ logger: false });
    registerAdminRoutes(app, admin(), null);
    await app.ready();
    const headers = { authorization: await bearer(['admin:read', 'admin:write']) };
    const read = await app.inject({ method: 'GET', url: '/admin/matching/in-flight', headers });
    expect(read.statusCode).toBe(503);
    expect(read.json()).toMatchObject({ code: 'edge.matching_unwired' });
    expect(JSON.stringify(read.json())).not.toContain('restingOrders');
    const post = await app.inject({ method: 'POST', url: '/admin/matching/halt', headers, payload: { marketId: 'BTC-USDT' } });
    expect(post.statusCode).toBe(503);
    expect(JSON.stringify(post.json())).not.toContain('restingOrders');
    await app.close();
  });

  it('refuses in-flight when EDGE_PRINCIPAL_SECRET is unset', async () => {
    const indexSrc = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(indexSrc).toMatch(/env\.MATCHING_URL && edgeSigningKey/);
    const app = Fastify({ logger: false });
    registerAdminRoutes(app, admin(), null);
    await app.ready();
    const read = await app.inject({
      method: 'GET',
      url: '/admin/matching/in-flight',
      headers: { authorization: await bearer(['admin:read']) },
    });
    expect(read.statusCode).toBe(503);
    expect(read.json()).toMatchObject({ code: 'edge.matching_unwired' });
    await app.close();
  });

  it('forwards the founder principal and not the bearer', async () => {
    const seen: { path: string; method: string; userId: string | undefined; forwarded: string }[] = [];
    const matching: MatchingOperatorCall = async (path, method, principal) => {
      const userId = principal && typeof principal === 'object' && 'userId' in principal ? principal.userId : undefined;
      seen.push({ path, method, userId, forwarded: JSON.stringify(principal) });
      return { status: 200, body: { venueHalted: false, restingOrders: 0, markets: [] } };
    };
    const app = Fastify({ logger: false });
    registerAdminRoutes(app, admin(), matching);
    await app.ready();
    const readHeaders = { authorization: await bearer(['admin:read'], false) };
    const read = await app.inject({ method: 'GET', url: '/admin/matching/in-flight', headers: readHeaders });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ venueHalted: false, restingOrders: 0 });
    expect(seen[0]).toMatchObject({ path: '/operator/in-flight', method: 'GET', userId: OPERATOR });
    expect(seen[0]?.forwarded).not.toContain(readHeaders.authorization);
    expect(seen[0]?.forwarded).not.toContain('Bearer');

    const writeHeaders = { authorization: await bearer(['admin:write']) };
    const write = await app.inject({
      method: 'POST',
      url: '/admin/matching/halt',
      headers: writeHeaders,
      payload: { marketId: 'BTC-USDT', approvalId: 'appr-1', operationId: 'op-1', idempotencyKey: 'halt-key-01' },
    });
    expect(write.statusCode).toBe(200);
    expect(seen[1]).toMatchObject({ path: '/operator/halt', method: 'POST', userId: OPERATOR });
    expect(seen[1]?.forwarded).not.toContain(writeHeaders.authorization);
    expect(JSON.stringify(seen)).not.toContain('authorization');
    await app.close();
  });

  it('signs the upstream principal and does not send authorization', async () => {
    const principal = await founder(['admin:read'], false);
    let initHeaders: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      initHeaders = (init.headers ?? {}) as Record<string, unknown>;
      return new Response(JSON.stringify({ venueHalted: false }), { status: 200 });
    });
    try {
      const call = httpMatchingOperator('http://matching.test', 1000, EDGE_SECRET);
      const res = await call('/operator/in-flight', 'GET', principal, undefined, 'GB');
      expect(res.status).toBe(200);
      expect(initHeaders?.authorization).toBeUndefined();
      const raw = initHeaders?.['x-intafaced-principal'];
      const sig = initHeaders?.['x-intafaced-principal-sig'];
      const region = initHeaders?.['x-intafaced-region'];
      expect(region).toBe('GB');
      expect(typeof raw).toBe('string');
      expect(typeof sig).toBe('string');
      const verified = verifyForwardedPrincipal(raw as string, sig as string, EDGE_SECRET, new Date(), region as string);
      expect(verified.principal?.userId).toBe(OPERATOR);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses the wrong session before calling matching', async () => {
    let calls = 0;
    const matching: MatchingOperatorCall = async () => {
      calls += 1;
      return { status: 200, body: {} };
    };
    const app = Fastify({ logger: false });
    registerAdminRoutes(app, admin(), matching);
    await app.ready();
    const missing = await app.inject({ method: 'GET', url: '/admin/matching/in-flight' });
    expect(missing.statusCode).toBe(401);
    const noRead = await app.inject({
      method: 'GET',
      url: '/admin/matching/in-flight',
      headers: { authorization: await bearer(['admin:write']) },
    });
    expect(noRead.statusCode).toBe(403);
    const readOnPost = await app.inject({
      method: 'POST',
      url: '/admin/matching/halt',
      headers: { authorization: await bearer(['admin:read']) },
      payload: {},
    });
    expect(readOnPost.statusCode).toBe(403);
    const noMfa = await app.inject({
      method: 'POST',
      url: '/admin/matching/halt',
      headers: { authorization: await bearer(['admin:write'], false) },
      payload: {},
    });
    expect(noMfa.statusCode).toBe(401);
    expect(noMfa.json()).toMatchObject({ code: 'mfa.required' });
    expect(calls).toBe(0);
    await app.close();
  });
});
