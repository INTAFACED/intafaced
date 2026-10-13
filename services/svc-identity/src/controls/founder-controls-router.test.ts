import Fastify, { type FastifyRequest } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import {
  encodePrincipal,
  signPrincipalHeader,
  serviceAuthHeadersForBody,
  serviceAuthHeaders,
  retainRawBody,
  type Context,
} from '@intafaced/contracts';
import { createIdentityRouter } from '../router.js';
import type { AuthService } from '../auth/auth-service.js';
import type { RankService } from '../rank/rank-service.js';
import { createDisableUserRouter } from '../disable-user-router.js';
import { createFounderControlsRouter, type FounderControlsPort } from './founder-controls-router.js';
import { createIdentityRequestContext } from './founder-context.js';

const USER = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';
const edgeSecret = 'a-founder-router-edge-secret-long-enough';
const internalSecret = 'a-founder-router-service-secret-long-enough';
const tokenConfig = {
  secret: 'a-founder-router-jwt-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
async function context(): Promise<Context> {
  const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['identity:write'], mfa: true }, tokenConfig);
  return { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: REQUEST };
}
function fixture() {
  const calls: Array<{ context: Context; input: unknown }> = [];
  const port: FounderControlsPort = {
    async change(ctx, input) {
      calls.push({ context: ctx, input });
      return {
        auditId: REQUEST,
        requestId: input.requestId,
        target: input.target,
        action: input.action,
        reason: input.reason,
        occurredAt: new Date().toISOString(),
        actorUserId: ctx.principal!.userId,
        outcome: 'refused',
        changed: false,
        code: 'operator.denied',
        current: null,
      };
    },
    async getState() {
      return null;
    },
    async history() {
      return [];
    },
    async changeEntitlement() {
      return { outcome: 'refused', auditId: REQUEST, entitlement: null, code: 'operator.denied' };
    },
    async operatorEntitlement(ctx, userId) {
      calls.push({ context: ctx, input: { userId } });
      return ctx.principal?.userId === userId
        ? { userId, status: 'enabled', version: '1', changedAt: new Date().toISOString() }
        : { userId, status: 'not_operator' };
    },
    async operatorStatus(ctx) {
      return { userId: ctx.principal!.userId, status: 'not_operator' };
    },
    async currentAuthority(input) {
      return { subject: input, checkedAt: new Date().toISOString(), status: 'unavailable', code: 'authority.unavailable' };
    },
  };
  return { port, calls };
}
const input = {
  requestId: REQUEST,
  target: { area: 'identity' as const, userId: TARGET },
  action: 'restrict' as const,
  reason: 'Incident review',
  expectedVersion: '0',
};

describe('identity founder control routes', () => {
  it('routes both legacy compliance names and disableUser through the new guarded transaction', async () => {
    const { port, calls } = fixture();
    const ctx = await context();
    const legacy = createIdentityRouter({} as AuthService, {} as RankService, { founderControls: port }).createCaller(ctx);
    await legacy.compliance.freezeIdentity(input);
    await legacy.compliance.unfreezeIdentity({ ...input, action: 'restore' });
    await createDisableUserRouter(port).createCaller(ctx).disableUser(input);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.context.principal === ctx.principal)).toBe(true);
    await expect(legacy.compliance.freezeIdentity({ userId: TARGET } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(legacy.compliance.unfreezeIdentity(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('rejects wrong targets, actor injection, anonymous reads and other-subject status inputs', async () => {
    const { port, calls } = fixture();
    const ctx = await context();
    const caller = createFounderControlsRouter(port).createCaller(ctx);
    for (const body of [
      { ...input, actorUserId: USER },
      { ...input, target: { area: 'merchant', merchantId: TARGET } },
      { ...input, target: { area: 'trading', userId: TARGET } },
    ]) {
      await expect(caller.accountControls.change(body as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(calls).toHaveLength(0);
    expect(await caller.accountControls.operatorStatus({})).toEqual({ userId: USER, status: 'not_operator' });
    await expect(caller.accountControls.operatorStatus({ userId: TARGET } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      createFounderControlsRouter(port)
        .createCaller({ ...ctx, principal: null })
        .accountControls.operatorStatus({}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.accountControls.operatorEntitlement({ userId: USER })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await caller.accountControls.getState({ target: input.target })).toBeNull();
    expect(await caller.accountControls.history({ target: input.target, limit: 1 })).toEqual([]);
    await expect(caller.accountControls.getState({ target: { area: 'merchant', merchantId: TARGET } } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.accountControls.history({ target: input.target } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.accountControls.history({ target: input.target, limit: 201 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('verifies real POST serialization, body-bound service HMAC and original signed principal', async () => {
    const { port, calls } = fixture();
    const ctx = await context();
    const app = Fastify();
    retainRawBody(app);
    const factory = createIdentityRequestContext({ secret: edgeSecret, internalSecret, serviceName: 'svc-identity' });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: { router: createFounderControlsRouter(port), createContext: ({ req }: { req: FastifyRequest }) => factory(req) },
    });
    const raw = encodePrincipal(ctx.principal!);
    const principalHeaders = {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, edgeSecret, 'DE'),
      'x-intafaced-region': 'DE',
    };
    const body = JSON.stringify({ userId: USER });
    const headers = {
      'content-type': 'application/json',
      ...principalHeaders,
      ...serviceAuthHeadersForBody('svc-ops', internalSecret, body),
    };
    try {
      const accepted = await app.inject({ method: 'POST', url: '/trpc/accountControls.operatorEntitlement', headers, payload: body });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ result: { data: { status: 'enabled', userId: USER } } });
      expect(calls[0]!.context.service).toBe('svc-ops');
      expect(calls[0]!.context.principal?.sid).toBe(SESSION);
      const tampered = await app.inject({
        method: 'POST',
        url: '/trpc/accountControls.operatorEntitlement',
        headers,
        payload: JSON.stringify({ userId: TARGET }),
      });
      expect(tampered.statusCode).toBe(401);
      expect(calls).toHaveLength(1);
      const encodedPath = await app.inject({
        method: 'POST',
        url: '/trpc/accountControls%2EoperatorEntitlement',
        headers: { 'content-type': 'application/json', ...principalHeaders, ...serviceAuthHeaders('svc-ops', internalSecret) },
        payload: body,
      });
      expect(encodedPath.statusCode).toBe(401);
      expect(calls).toHaveLength(1);
      const envelope = JSON.stringify({ json: { userId: USER } });
      const wrapped = await app.inject({
        method: 'POST',
        url: '/trpc/accountControls.operatorEntitlement',
        headers: { ...headers, ...serviceAuthHeadersForBody('svc-ops', internalSecret, envelope) },
        payload: envelope,
      });
      expect(wrapped.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
