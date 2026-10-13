import Fastify, { type FastifyRequest } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { describe, expect, it } from 'vitest';
import { retainRawBody, serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { createActionApprovalRouter } from '../action-approval-router.js';
import type { ActionApprovalService } from '../auth/action-approval-service.js';
import { createIdentityRequestContext } from './founder-context.js';

const edgeSecret = 'a-consume-auth-edge-secret-long-enough';
const internalSecret = 'a-consume-auth-service-secret-long-enough';
const input = {
  approvalId: 'appr-1',
  operationId: 'op-1',
  payloadHash: 'sha256:abc',
  targetService: 'svc-matching',
  targetId: 'open:market-1',
  expectedVersion: '1',
};

function service(calls: string[]): Pick<ActionApprovalService, 'consume'> {
  return {
    async consume(caller, i) {
      calls.push(caller);
      return {
        ...i,
        actionType: 'matching.open',
        requesterId: 'user-a',
        approverId: 'user-b',
        policyVersion: 'v1',
        createdAt: '2026-10-13T00:00:00.000Z',
        expiresAt: '2026-10-13T00:10:00.000Z',
        status: 'CONSUMED',
      };
    },
  };
}

describe('identity actionApproval.consume service authentication', () => {
  it('accepts the body-bound service call a target service sends over real HTTP, and refuses a tampered body', async () => {
    const calls: string[] = [];
    const app = Fastify();
    retainRawBody(app);
    const factory = createIdentityRequestContext({ secret: edgeSecret, internalSecret, serviceName: 'svc-identity' });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: createActionApprovalRouter(service(calls) as ActionApprovalService),
        createContext: ({ req }: { req: FastifyRequest }) => factory(req),
      },
    });
    try {
      const body = JSON.stringify(input);
      const headers = { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-matching', internalSecret, body) };
      const ok = await app.inject({ method: 'POST', url: '/trpc/actionApproval.consume', headers, payload: body });
      expect(ok.statusCode).toBe(200);
      expect(calls).toEqual(['svc-matching']);

      const tampered = await app.inject({
        method: 'POST',
        url: '/trpc/actionApproval.consume',
        headers,
        payload: JSON.stringify({ ...input, targetId: 'open:market-2' }),
      });
      expect(tampered.statusCode).toBe(401);

      const wrongSecret = await app.inject({
        method: 'POST',
        url: '/trpc/actionApproval.consume',
        headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-matching', 'x'.repeat(40), body) },
        payload: body,
      });
      expect(wrongSecret.statusCode).toBe(401);

      const unsigned = await app.inject({
        method: 'POST',
        url: '/trpc/actionApproval.consume',
        headers: { 'content-type': 'application/json' },
        payload: body,
      });
      expect(unsigned.statusCode).toBe(401);
      expect(calls).toHaveLength(1);
      void serviceAuthHeaders;
    } finally {
      await app.close();
    }
  });
});
