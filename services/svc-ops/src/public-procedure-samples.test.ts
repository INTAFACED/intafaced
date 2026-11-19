import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEdgeContext, router, VALUATION_PRICES_UNSET } from '@intafaced/contracts';
import { OPS_PUBLIC_PROCEDURES } from '@intafaced/contracts/ops-public-procedures';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { createHomeConfigRouter, homeConfigFromEnv } from './home-config.js';
import { createValuationPricesRouter } from './valuation-prices.js';
import { createOutreachRouter } from './outreach/router.js';
import type { OutreachCrm } from './outreach/crm.js';
import type { PublicSettingsBook } from './outreach/public-settings.js';

/**
 * The mounted side of svc-ops' public records: each record's samples, sent signed out through the production adapter,
 * reach their verdict, and `outreach.publicSettings` with no settings store sends its one named refusal as before.
 */

const edgeContext = createEdgeContext({ secret: 'an-ops-public-samples-edge-secret-long-enough', serviceName: 'svc-ops' });
const book: PublicSettingsBook = {
  get: async () => ({ joinUrl: null, partnerTerms: null, appStoreUrl: null, revision: 0, updatedAt: null }),
  set: async () => {
    throw new Error('not reached');
  },
};
const noAuthority = async () => undefined;

async function serve(withBook: boolean) {
  const app = Fastify();
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: router({
        home: createHomeConfigRouter(homeConfigFromEnv({})),
        valuation: createValuationPricesRouter({ published: false, code: VALUATION_PRICES_UNSET }),
        outreach: createOutreachRouter({} as OutreachCrm, noAuthority as never, withBook ? book : undefined),
      }),
      createContext: ({ req }: { req: unknown }) => edgeContext(req as never),
    },
  });
  return app;
}

let app: Awaited<ReturnType<typeof serve>>;
let bookless: Awaited<ReturnType<typeof serve>>;
beforeAll(async () => {
  vi.stubEnv('APP_ENV', 'test');
  app = await serve(true);
  bookless = await serve(false);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
  await bookless.close();
});

const cases = OPS_PUBLIC_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({ record, sample, label: `${record.name} #${i} ${sample.verdict}` })),
);

describe("svc-ops' public routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const input = sample.input;
    const res = await app.inject({
      method: 'GET',
      url: `/trpc/${record.path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
    });
    expect(res.statusCode, res.body).toBe(sample.verdict === 'refuse' ? 400 : 200);
    expect(record.output.safeParse(JSON.parse(res.body).result.data).success).toBe(true);
  });

  it('outreach.publicSettings with no settings store refuses ops.crm.storage_unconfigured as PRECONDITION_FAILED', async () => {
    const res = await bookless.inject({ method: 'GET', url: '/trpc/outreach.publicSettings' });
    expect(res.statusCode).toBe(412);
    expect(JSON.parse(res.body).error).toMatchObject({ message: 'ops.crm.storage_unconfigured', data: { code: 'PRECONDITION_FAILED' } });
  });
});
