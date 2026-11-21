import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, PREVIEW_REFUSAL_CODE, router, signPrincipalHeader } from '@intafaced/contracts';
import { BANK_CREDIT_PREVIEW_PROCEDURES } from '@intafaced/contracts/bank-credit-preview-procedures';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { fraudPreviewDoor } from '../cards/fraud-preview.js';
import { createCreditCardPreviewRouter } from './credit-card-preview.router.js';
import { createCreditPreviewsRouter } from './credit-previews.js';
import { loanServicingPreviewProcedures } from './loan-servicing-preview.js';

/**
 * The mounted side of each credit-preview record's samples (the J-bank-12 doors, the older loan-servicing, credit-card and fraud preview doors they call), through the production adapter by a caller the record admits:
 * a refused sample is answered 400 (the input is malformed); an accepted read answers 200, and an accepted engine action
 * answers the typed Preview refusal with the status its record lists (412), under the strict check that fails on a refusal
 * the record does not list.
 */

const SECRET = 'a-bank-credit-preview-samples-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['bank:read', 'bank:write', 'admin:treasury'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

const app = Fastify();

beforeAll(async () => {
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('PROCEDURE_REFUSALS_STRICT', '1');
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: router({
        creditPreviews: createCreditPreviewsRouter(),
        loans: router(loanServicingPreviewProcedures(null)),
        creditCard: createCreditCardPreviewRouter(),
        ops: router({ fraudPreview: fraudPreviewDoor() }),
      }),
      createContext: ({ req }: { req: unknown }) => edgeContext(req as never),
    },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

async function send(record: (typeof BANK_CREDIT_PREVIEW_PROCEDURES)[number], input: unknown) {
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

const cases = BANK_CREDIT_PREVIEW_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-bank's credit-preview routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else if (record.kind === 'query') expect(res.statusCode, res.body).toBe(200);
    else {
      expect(res.body).toContain(PREVIEW_REFUSAL_CODE);
      expect(record.refusals[PREVIEW_REFUSAL_CODE]).toBe('PRECONDITION_FAILED');
      expect(res.statusCode, res.body).toBe(412);
    }
  });
});
