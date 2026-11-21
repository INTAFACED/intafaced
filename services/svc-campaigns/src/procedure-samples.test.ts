import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { CAMPAIGNS_PROCEDURES } from '@intafaced/contracts/campaigns-procedures';
import { createCampaignsRouter, type CampaignServices } from './router.js';

/**
 * The mounted side of each svc-campaigns record's samples: sent through the production adapter by a caller the record
 * admits (every campaigns scope, with a second factor), a refused sample is answered 400 (the input is malformed), an
 * accepted one never is. The record's zod schema and its JSON export run the same samples in `@intafaced/contracts`
 * (`procedure-registry.test.ts`).
 *
 * No database, ledger or partner: an accepted input reaches the service and fails there, which is not a 400.
 */

const SECRET = 'a-campaigns-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-campaigns' });

function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['campaigns:read', 'campaigns:write', 'campaigns:ops'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

/** Every service call throws: a sample that gets past the input reaches here and fails as a 500, never a 400. */
function absent<T extends object>(name: string): T {
  const target: object = {};
  return new Proxy(target, {
    get: () => () => {
      throw new Error(`samples: no ${name}`);
    },
  }) as T;
}
const services: Required<CampaignServices> = {
  drops: absent('drops'),
  campaigns: absent('campaigns'),
  tasks: absent('tasks'),
  vouchers: absent('vouchers'),
  watch: absent('watch'),
  referrals: absent('referrals'),
  competitions: absent('competitions'),
  draws: absent('draws'),
  distributions: absent('distributions'),
  pools: absent('pools'),
  trialPasses: absent('trialPasses'),
  risk: absent('risk'),
};
const app = Fastify();

beforeAll(async () => {
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: createCampaignsRouter(services), createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(() => app.close());

const cases = CAMPAIGNS_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-campaigns' mounted routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const input = sample.input;
    const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
    const res =
      record.kind === 'query'
        ? await app.inject({ method: 'GET', url, headers: signedIn() })
        : await app.inject({
            method: 'POST',
            url,
            headers: { ...signedIn(), 'content-type': 'application/json' },
            payload: input === undefined ? '' : JSON.stringify(input),
          });
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else {
      expect(res.statusCode, res.body).not.toBe(400);
      expect(res.body, 'an accepted sample reaches the service').toContain('samples: no ');
    }
  });
});
