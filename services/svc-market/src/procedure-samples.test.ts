import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MARKET_PROCEDURES } from '@intafaced/contracts/market-procedures';
import type { ProcedureRecord, ProcedureSample } from '@intafaced/contracts/procedure';
import type { ActionApprovalConsumer } from './action-approval-consume.js';
import type { CommerceService } from './commerce/commerce-service.js';
import type { PerpProposalService } from './perp-proposal-service.js';
import type { ReviewsService } from './reviews/reviews-service.js';
import type { SignalPublisher } from './signals/signal-publisher.js';
import type { VendorService } from './vendor-service.js';
import { createMarketRouter } from './router.js';

/**
 * The mounted side of each svc-market record's samples: sent through the production Fastify adapter with the edge
 * context `index.ts` builds, by a caller the record admits, from a served region. A refused sample is answered 400
 * naming no refusal code (its input failed the record's schema); an accepted one never is. Under the run's
 * `PROCEDURE_REFUSALS_STRICT=1` (`vitest.config.ts`), a refusal a handler sends that its record does not list, or lists
 * with another status, fails the call. The record's zod schema and its JSON export run the same samples in `@intafaced/contracts`
 * (`procedure-registry.test.ts`).
 *
 * No database, ledger or outside service: every service call throws, so an input that gets past the record reaches the
 * handler and fails there as a 500, never a 400.
 */

const SECRET = 'a-market-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-market' });

/** Signed in with the market's scopes, an operator's included, at tier basic from a served region. */
function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['market:read', 'market:write', 'market:ops'],
    tier: 'basic',
    mfa: true,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

const absent = <T>(name: string): T =>
  new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(`samples: no ${name}`);
      },
    },
  ) as T;

const app = Fastify();
beforeAll(async () => {
  const router = createMarketRouter(
    absent<VendorService>('vendors'),
    absent<CommerceService>('commerce'),
    absent<PerpProposalService>('perp proposals'),
    absent<ActionApprovalConsumer>('approvals'),
    absent<ReviewsService>('reviews'),
    absent<SignalPublisher>('signals'),
  );
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router, createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(() => app.close());

async function send(record: ProcedureRecord, input: unknown) {
  if (record.transport !== 'trpc') throw new Error(`${record.name} is not a tRPC record`);
  const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  return record.kind === 'query'
    ? app.inject({ method: 'GET', url, headers: signedIn() })
    : app.inject({
        method: 'POST',
        url,
        headers: { ...signedIn(), 'content-type': 'application/json' },
        payload: input === undefined ? '' : JSON.stringify(input),
      });
}

const causeCode = (body: string): unknown =>
  (JSON.parse(body) as { error?: { data?: { cause?: { code?: unknown } } } }).error?.data?.cause?.code;

const cases = MARKET_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({ record, sample, label: `${record.name} #${i} ${sample.verdict}` })),
);

describe("svc-market's mounted routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    const forInput = res.statusCode === 400 && causeCode(res.body) === undefined;
    expect(forInput, `${res.statusCode} ${res.body}`).toBe(sample.verdict === 'refuse');
  });
});
