import Fastify, { type FastifyRequest } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import {
  encodePrincipal,
  mergeRouters,
  retainRawBody,
  router,
  serviceAuthHeaders,
  serviceAuthHeadersForBody,
  serviceProcedure,
  signPrincipalHeader,
  type Context,
  type IdentityOperationDecisionInput,
  type IdentityOperationDecision,
} from '@intafaced/contracts';
import { createIdentityRequestContext } from './founder-context.js';
import { createOperationIdentityRouter } from './operation-identity-router.js';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '33333333-3333-4333-8333-333333333333';
const GRANT = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-10T12:00:00.000Z';
const EDGE_SECRET = 'operation-router-edge-secret-long-enough';
const INTERNAL_SECRET = 'operation-router-generic-service-secret';
const TRADE_SECRET = 'operation-router-trade-owner-secret-long-enough';
const PAY_SECRET = 'operation-router-pay-owner-secret-long-enough';
const tokenConfig = {
  secret: 'operation-router-jwt-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const tradeInput: IdentityOperationDecisionInput = {
  mode: 'grant',
  intent: {
    operation: { service: 'svc-trade', kind: 'order.place', userId: USER },
    businessId: 'order:client-42',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    authority: { kind: 'credential', subject: { userId: USER, credential: { kind: 'session', sessionId: SESSION } } },
  },
};

const payInput: IdentityOperationDecisionInput = {
  mode: 'grant',
  intent: {
    operation: { service: 'svc-pay', kind: 'payment.capture', userId: USER, merchantId: MERCHANT },
    businessId: 'payment:capture:payment-42',
    payloadHash: `sha256:${'b'.repeat(64)}`,
    authority: { kind: 'merchant_policy', merchantId: MERCHANT },
  },
};

function fixture(options: { tradeSecret?: string; paySecret?: string; internalSecret?: string } = {}) {
  const calls: Array<{ context: Context; input: IdentityOperationDecisionInput; owner: string }> = [];
  const serviceCalls: Array<string | null> = [];
  const config = {
    secret: EDGE_SECRET,
    internalSecret: options.internalSecret ?? INTERNAL_SECRET,
    serviceName: 'svc-identity',
    operationAdmissionSecrets: {
      ...(options.tradeSecret === undefined ? { 'svc-trade': TRADE_SECRET } : { 'svc-trade': options.tradeSecret }),
      ...(options.paySecret === undefined ? { 'svc-pay': PAY_SECRET } : { 'svc-pay': options.paySecret }),
    },
  };
  const contextFactory = createIdentityRequestContext(config);
  const decisions = {
    async decide(input: IdentityOperationDecisionInput, owner: string): Promise<IdentityOperationDecision> {
      calls.push({ context: { principal: null, service: owner, region: 'DE', requestId: 'test' }, input, owner });
      return {
        status: 'granted',
        intent: input.intent,
        grantId: GRANT,
        identityVersion: '9007199254740993',
        decidedAt: NOW,
      };
    },
  };
  const operationRouter = createOperationIdentityRouter(decisions);
  const combinedRouter = mergeRouters(
    operationRouter,
    router({
      arbitrary: router({
        ping: serviceProcedure.mutation(({ ctx }) => {
          serviceCalls.push(ctx.service);
          return { service: ctx.service };
        }),
      }),
    }),
  );
  const app = Fastify();
  retainRawBody(app);
  void app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: combinedRouter,
      createContext: ({ req }: { req: FastifyRequest }) => contextFactory(req),
    },
  });
  return { app, calls, serviceCalls };
}

async function signedInteractivePrincipal() {
  const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:write'], mfa: true }, tokenConfig);
  return await verifyAccessToken(token, tokenConfig);
}

function principalHeaders(principal: Awaited<ReturnType<typeof signedInteractivePrincipal>>) {
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function requestHeaders(owner: 'svc-trade' | 'svc-pay', secret: string, body: string) {
  return { 'content-type': 'application/json', ...serviceAuthHeadersForBody(owner, secret, body) };
}

describe('operation admission owner HTTP boundary', () => {
  it('authenticates trade and pay with only their dedicated keys and returns raw tRPC data', async () => {
    const { app, calls } = fixture();
    try {
      for (const [input, owner, secret] of [
        [tradeInput, 'svc-trade', TRADE_SECRET],
        [payInput, 'svc-pay', PAY_SECRET],
      ] as const) {
        const body = JSON.stringify(input);
        const response = await app.inject({
          method: 'POST',
          url: '/trpc/operationAdmission.decide',
          headers: requestHeaders(owner, secret, body),
          payload: body,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().result.data).toMatchObject({
          status: 'granted',
          intent: input.intent,
          identityVersion: '9007199254740993',
        });
        expect(response.json().result.data.json).toBeUndefined();
      }
      expect(calls.map((call) => call.owner)).toEqual(['svc-trade', 'svc-pay']);
    } finally {
      await app.close();
    }
  });

  it('rejects missing, generic, legacy-v1, unbound, or tampered signatures before the decision port', async () => {
    const { app, calls } = fixture();
    try {
      const body = JSON.stringify(tradeInput);
      const cases = [
        { headers: { 'content-type': 'application/json' }, payload: body },
        { headers: requestHeaders('svc-trade', INTERNAL_SECRET, body), payload: body },
        {
          headers: { 'content-type': 'application/json', ...serviceAuthHeaders('svc-trade', TRADE_SECRET) },
          payload: body,
        },
        {
          headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', TRADE_SECRET, '') },
          payload: JSON.stringify({ ...tradeInput, mode: 'resolve_or_cancel' }),
        },
        {
          headers: requestHeaders('svc-trade', TRADE_SECRET, body),
          payload: JSON.stringify({ ...tradeInput, mode: 'resolve_or_cancel' }),
        },
      ];
      for (const candidate of cases) {
        const response = await app.inject({ method: 'POST', url: '/trpc/operationAdmission.decide', ...candidate });
        expect(response.statusCode).toBe(401);
      }
      expect(calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('refuses encoded procedure and mixed batches before any service procedure runs', async () => {
    const { app, calls, serviceCalls } = fixture();
    try {
      const body = JSON.stringify(tradeInput);
      const encoded = await app.inject({
        method: 'POST',
        url: '/trpc/operationAdmission%2Edecide',
        headers: { 'content-type': 'application/json', ...serviceAuthHeaders('svc-trade', TRADE_SECRET) },
        payload: body,
      });
      expect(encoded.statusCode).toBe(401);

      const batchBody = JSON.stringify({ 0: { json: tradeInput }, 1: { json: {} } });
      const batch = await app.inject({
        method: 'POST',
        url: '/trpc/operationAdmission.decide,arbitrary.ping?batch=1',
        headers: requestHeaders('svc-trade', TRADE_SECRET, batchBody),
        payload: batchBody,
      });
      expect(batch.statusCode).toBe(401);
      expect(calls).toHaveLength(0);
      expect(serviceCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('rejects owner-key and body-service mismatches with forbidden before the decision port', async () => {
    const { app, calls } = fixture();
    try {
      const body = JSON.stringify(payInput);
      const response = await app.inject({
        method: 'POST',
        url: '/trpc/operationAdmission.decide',
        headers: requestHeaders('svc-trade', TRADE_SECRET, body),
        payload: body,
      });
      expect(response.statusCode).toBe(403);
      expect(calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('does not let a signed interactive principal or aliased owner secrets act as the service', async () => {
    const principal = await signedInteractivePrincipal();
    const ordinary = fixture();
    try {
      const body = JSON.stringify(tradeInput);
      const response = await ordinary.app.inject({
        method: 'POST',
        url: '/trpc/operationAdmission.decide',
        headers: { 'content-type': 'application/json', ...principalHeaders(principal) },
        payload: body,
      });
      expect(response.statusCode).toBe(401);
      expect(ordinary.calls).toHaveLength(0);
    } finally {
      await ordinary.app.close();
    }

    for (const config of [
      { tradeSecret: INTERNAL_SECRET },
      { tradeSecret: PAY_SECRET },
      { paySecret: INTERNAL_SECRET },
      { paySecret: TRADE_SECRET },
    ]) {
      const aliased = fixture(config);
      try {
        const input = config.paySecret ? payInput : tradeInput;
        const owner = config.paySecret ? 'svc-pay' : 'svc-trade';
        const secret = config.paySecret ?? config.tradeSecret!;
        const body = JSON.stringify(input);
        const refused = await aliased.app.inject({
          method: 'POST',
          url: '/trpc/operationAdmission.decide',
          headers: requestHeaders(owner, secret, body),
          payload: body,
        });
        expect(refused.statusCode).toBe(401);
        expect(aliased.calls).toHaveLength(0);
      } finally {
        await aliased.app.close();
      }
    }
  });
});
