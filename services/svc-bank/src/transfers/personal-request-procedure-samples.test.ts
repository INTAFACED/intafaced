import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, router, signPrincipalHeader } from '@intafaced/contracts';
import { BANK_PERSONAL_REQUEST_PROCEDURES } from '@intafaced/contracts/bank-personal-request-procedures';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { BankError } from '../errors.js';
import { guard } from '../router/errors.js';
import { createPersonalRequestRouter } from './personal-request.router.js';

/**
 * The mounted side of each personal-request record's samples: sent through the production adapter by a caller the record
 * admits, a refused sample is answered 400 (the input is malformed), an accepted one 200. A refusal the service throws
 * leaves with the status its record lists, under the strict check that fails on a refusal the record does not list. The
 * record's zod schema and its JSON export run the same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const SECRET = 'a-bank-personal-request-samples-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = 'b3a7c1e2-4d5f-4a6b-8c9d-0e1f2a3b4c5d';
const MISSING = '44444444-4444-4444-8444-444444444444';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

const view = {
  requestId: REQUEST_ID,
  payeeUserId: USER,
  payerUserId: OTHER,
  payeeHandle: 'ann',
  payerHandle: 'bob',
  assetId: 'USDT',
  amount: '12.5',
  note: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  status: 'open' as const,
  ledgerTxId: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  notice: { delivered: true, blocker: null },
};
const reminder = { sentInWindow: 1, cap: 3, windowSeconds: 86_400, nextAllowedAt: null };
const safety = {
  caseId: '55555555-5555-4555-8555-555555555555',
  reason: 'scam' as const,
  state: 'open' as const,
  openedAt: view.createdAt,
  blocked: true,
};
const notFound = () => new BankError(`Request ${MISSING} not found (bank.personal_request_not_found)`, 'bank.personal_request_not_found');

/** Each method a sample reaches answers a valid reply; the one missing request is refused as svc-bank refuses it. */
const byId = async (_user: string, requestId: string) => {
  if (requestId === MISSING) throw notFound();
  return view;
};
const personalPay = {
  createRequest: async () => view,
  listRequests: async () => [view],
  getRequest: byId,
  cancelRequest: byId,
  declineRequest: byId,
  remindRequest: async () => ({ ...view, reminder }),
  reminders: async (_user: string, requestId: string) => {
    if (requestId === MISSING)
      throw new BankError('No reminder rule is published (bank.reminder_policy_unset)', 'bank.reminder_policy_unset');
    return reminder;
  },
  reportRequest: async () => ({ request: { ...view, status: 'declined' as const }, safety }),
  requestSafety: async () => safety,
};
const app = Fastify();

beforeAll(async () => {
  // A test stack, as the wire replay runs: the screening gate is not what these samples test.
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('PROCEDURE_REFUSALS_STRICT', '1');
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: router({ personalRequest: createPersonalRequestRouter({ personalPay } as never, guard) }),
      createContext: ({ req }: { req: unknown }) => edgeContext(req as never),
    },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

async function send(record: (typeof BANK_PERSONAL_REQUEST_PROCEDURES)[number], input: unknown) {
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

const cases = BANK_PERSONAL_REQUEST_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-bank's personal-request routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else expect(res.statusCode, res.body).toBe(200);
  });

  it.each(BANK_PERSONAL_REQUEST_PROCEDURES.filter((r) => ['get', 'cancel', 'decline', 'reminders'].includes(r.path.split('.')[1]!)))(
    '$name sends its listed refusal with the status the record names',
    async (record) => {
      const res = await send(record, { requestId: MISSING });
      const code = record.path.endsWith('reminders') ? 'bank.reminder_policy_unset' : 'bank.personal_request_not_found';
      expect(res.body).toContain(code);
      expect(res.statusCode, res.body).toBe(record.refusals[code] === 'NOT_FOUND' ? 404 : 412);
    },
  );
});
