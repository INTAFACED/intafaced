/**
 * The lead desk's doors on the mounted router (CB-copy-12): a refusal crosses /trpc with its own code, so the customer
 * room and the console can name it. A desk refusal mapped to a TRPCError must not be wrapped again as a 500.
 */
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTradeRouter, type TradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import { CopyError } from './errors.js';
import type { LeadDesk } from './lead-applications.js';

const EDGE_SECRET = 'a-trade-lead-desk-door-edge-secret-32by';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-trade' });

function headers(): Record<string, string> {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

async function applyRefusedWith(error: Error) {
  const desk = {
    apply: async () => {
      throw error;
    },
  } as unknown as LeadDesk;
  const router = createTradeRouter({} as TradeService, undefined, undefined, undefined, undefined, undefined, undefined, desk);
  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router, createContext: ({ req }) => edgeContext(req) } satisfies FastifyTRPCPluginOptions<TradeRouter>['trpcOptions'],
  });
  await app.ready();
  try {
    const res = await app.inject({ method: 'POST', url: '/trpc/copy.applyToLead', headers: headers(), payload: { displayName: 'TEST' } });
    return {
      status: res.statusCode,
      body: res.json() as { error?: { message?: string; data?: { code?: string; cause?: { code?: string } } } },
    };
  } finally {
    await app.close();
  }
}

describe('lead desk doors', () => {
  it('a re-apply before the unset wait is refused with its code, not a 500', async () => {
    const { status, body } = await applyRefusedWith(
      new CopyError('The wait before applying again is not set by the platform', 'trade.copy_lead_reapply_wait_unset'),
    );
    expect(status).toBe(400);
    expect(body.error?.data?.code).toBe('BAD_REQUEST');
    expect(body.error?.data?.cause?.code).toBe('trade.copy_lead_reapply_wait_unset');
    expect(body.error?.message).toContain('[trade.copy_lead_reapply_wait_unset]');
  });

  it('blank criteria answer PRECONDITION_FAILED with their code', async () => {
    const { status, body } = await applyRefusedWith(new CopyError('The lead criteria are not set', 'trade.copy_lead_criteria_unset'));
    expect(status).toBe(412);
    expect(body.error?.data?.cause?.code).toBe('trade.copy_lead_criteria_unset');
  });
});
