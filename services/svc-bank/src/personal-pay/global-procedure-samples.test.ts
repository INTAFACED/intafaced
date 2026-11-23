import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, router, signPrincipalHeader } from '@intafaced/contracts';
import { BANK_GLOBAL_PROCEDURES, BANK_GLOBAL_SEND } from '@intafaced/contracts/bank-global-procedures';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { BankError } from '../errors.js';
import { personalPayError } from './errors.js';
import { createGlobalRouter } from './router.js';

/**
 * The mounted side of each `global.*` record's samples: sent through the production adapter by a caller the record
 * admits, a refused sample is answered 400 (the input is malformed), an accepted one 200. A refusal the service throws
 * leaves with the status its record lists, under the strict check that fails on a refusal the record does not list. The
 * record's zod schema and its JSON export run the same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const SECRET = 'a-bank-global-samples-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
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

const at = '2026-11-20T00:00:00.000Z';
const send = {
  id: 'c4b8d2f3-5e6a-4b7c-9d0e-1f2a3b4c5d6e',
  fromSpaceId: 'd5c9e3a4-6f7b-4c8d-8e1f-2a3b4c5d6e7f',
  assetId: 'USDC',
  amount: '100',
  toCurrency: 'EUR',
  recipientId: 'e6d0f4b5-7a8c-4d9e-9f2a-3b4c5d6e7f80',
  country: 'DE',
  deliveryMethod: 'bank_account',
  status: 'sent' as const,
  failureCode: null,
  failureBlocker: null,
  providerRef: null,
  quoteRate: null,
  quoteFee: null,
  quoteFeeAsset: null,
  quoteReceive: null,
  quoteValidUntil: null,
  quoteEta: null,
  quoteId: null,
  ledgerTxId: null,
  cancelledBy: null,
  returnRef: null,
  returnedAt: null,
  refundedAt: null,
  recallReason: null,
  recallRequestedAt: null,
  createdAt: at,
  updatedAt: at,
};
const recipient = {
  id: send.recipientId,
  label: null,
  name: 'Ann Example',
  account: 'DE89370400440532013000',
  accountKind: 'iban' as const,
  bic: null,
  country: 'DE',
  createdAt: at,
};
const hold = {
  state: 'requested' as const,
  infoRequest: null,
  proofUploaded: false,
  proofLimits: null,
  autoCancel: { state: 'unset' as const, hours: null, at: null },
};
const quote = {
  quoteId: 'f7e1a5c6-8b9d-4e0f-8a3b-4c5d6e7f8091',
  lockedAt: at,
  rate: '0.92',
  fee: '1',
  feeAsset: 'USDC',
  receiveAmount: '91.08',
  validUntil: at,
  eta: 'PT1H',
};
/** The one missing send each read and close is asked about: refused as svc-bank refuses it. */
const ownSend = async (_user: string, id: string) => {
  if (id === MISSING) throw personalPayError('bank.global_not_found');
  return send;
};

const globalSend = {
  partner: () => ({ standIn: 'TEST' }),
  corridors: async () => [],
  validateRecipient: async () => ({
    format: 'valid' as const,
    formatKind: 'iban' as const,
    normalized: recipient.account,
    bicLookup: { status: 'not_requested' as const },
  }),
  addRecipient: async () => recipient,
  listRecipients: async () => [recipient],
  removeRecipient: async () => ({ removed: true as const }),
  quote: async () => quote,
  send: async () => send,
  list: async () => ({ items: [send], nextCursor: null }),
  recall: async (input: { id: string }) => ownSend(USER, input.id),
  receipt: async (_user: string, id: string) => {
    await ownSend(USER, id);
    return { fileName: 'receipt.txt', text: 'TEST', ledgerTxId: 'tx', sha256: 'a', signature: 'b' };
  },
};
const globalHolds = {
  expireOverdue: async () => 0,
  forCustomer: async (_user: string, id: string) => {
    await ownSend(USER, id);
    return hold;
  },
  uploadProof: async () => hold,
  cancel: ownSend,
};
const spaces = { get: async () => ({ id: send.fromSpaceId, userId: USER, assetId: 'USDC' }) };
const stepUp = {
  mode: 'off' as const,
  require: async (req: { approvalId?: string }) => {
    if (req.approvalId === undefined) throw new BankError('Confirm this send first (bank.step_up_required)', 'bank.step_up_required');
  },
};
const app = Fastify();

beforeAll(async () => {
  // A test stack, as the wire replay runs: the screening gate is not what these samples test.
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('PROCEDURE_REFUSALS_STRICT', '1');
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: router({ global: createGlobalRouter({ globalSend, globalHolds, spaces } as never, stepUp as never) }),
      createContext: ({ req }: { req: unknown }) => edgeContext(req as never),
    },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

async function call(record: (typeof BANK_GLOBAL_PROCEDURES)[number], input: unknown) {
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

const cases = BANK_GLOBAL_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);
const byPath = (path: string) => {
  const record = BANK_GLOBAL_PROCEDURES.find((r) => r.path === path);
  if (!record) throw new Error(`no record at ${path}`);
  return record;
};

describe("svc-bank's global routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await call(record, sample.input);
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else expect(res.statusCode, res.body).toBe(200);
  });

  it.each(['global.hold.get', 'global.cancel', 'global.receipt'].map(byPath))(
    '$name sends a missing send as the record lists it',
    async (record) => {
      const res = await call(record, { id: MISSING });
      expect(res.body).toContain('bank.global_not_found');
      expect(record.refusals['bank.global_not_found']).toBe('NOT_FOUND');
      expect(res.statusCode, res.body).toBe(404);
    },
  );

  it('global.recall sends a missing send as the record lists it', async () => {
    const res = await call(byPath('global.recall'), { id: MISSING, reason: 'Wrong account' });
    expect(res.body).toContain('bank.global_not_found');
    expect(res.statusCode, res.body).toBe(404);
  });

  it('global.send without its confirmation is refused with the step-up code the record lists', async () => {
    const record = BANK_GLOBAL_SEND;
    const { stepUpApprovalId: _dropped, ...unconfirmed } = record.samples[0].input;
    const res = await call(record, unconfirmed);
    expect(res.body).toContain('bank.step_up_required');
    expect(record.refusals['bank.step_up_required']).toBe('PRECONDITION_FAILED');
    expect(res.statusCode, res.body).toBe(412);
  });
});
