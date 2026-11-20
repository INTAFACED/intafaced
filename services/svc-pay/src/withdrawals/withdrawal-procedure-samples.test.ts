import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { PAY_WITHDRAWAL_PROCEDURES } from '@intafaced/contracts/pay-withdrawal-procedures';
import type { ProcedureSample, RefusalStatus } from '@intafaced/contracts/procedure';
import { parseAmount } from '@intafaced/ledger-client';
import { createPayRouter } from '../router.js';
import { PayError, type PayErrorCode, type PayService } from '../payment-service.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import { PayGuardRefusal } from '../seams/guards.js';
import type { UserMoneyService } from '../user-money-service.js';
import { WithdrawalApprovalError, type WithdrawalApprovalErrorCode } from './approvals/errors.js';
import { WithdrawalNetworkRuleError, type WithdrawalNetworkRuleErrorCode } from './network-rules/service.js';
import { WithdrawalQuoteError, type WithdrawalQuoteErrorCode } from './quotes/errors.js';
import type { WithdrawalQuoteService } from './quotes/service.js';

/**
 * The mounted side of each `withdrawal.*` record, through svc-pay's whole router. Its path is on the router with the
 * record's own input and output parsers; each sample, sent through the production adapter by a caller the record admits,
 * reaches its verdict (a refused sample is answered 400, an accepted one 200); and every refusal the record lists, thrown
 * as the typed error svc-pay makes it from, leaves with the status it names, under the strict check that fails on a
 * refusal the record does not list. The record's zod schema and its JSON export run the same samples in
 * `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const SECRET = 'a-pay-withdrawal-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' });
type WithdrawalRecord = (typeof PAY_WITHDRAWAL_PROCEDURES)[number];

function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write', 'trade:withdraw'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

const row = {
  id: ID,
  userId: USER,
  assetId: 'USDC',
  amount: parseAmount('25.5'),
  rail: 'crypto-native',
  destination: { kind: 'crypto', ref: '0x1111111111111111111111111111111111111111' },
  clientRef: 'w-1',
  railRef: null,
  attempts: 0,
  failureCode: null,
  status: 'pending',
  createdAt: new Date('2026-11-20T00:00:00.000Z'),
  networkId: 'ethereum',
  fee: parseAmount('0.5'),
};
const figures = { perTx: '1000', rolling24h: '5000' };
const quote = {
  quoteRef: 'q:1',
  assetId: 'USDC',
  networkId: 'ethereum',
  amount: '25.5',
  feeMode: 'on_top',
  fees: [{ kind: 'network', amount: '0.5' }],
  feeTotal: '0.5',
  netAmount: '25.5',
  totalDebit: '26',
  feeSource: 'registry',
  quotedAt: '2026-11-20T00:00:00.000Z',
  expiresAt: '2026-11-20T00:05:00.000Z',
  expired: false,
  acceptedBy: null,
};

/** What each service method answers when it answers: what makes a valid reply of its record. */
const replies: Record<string, unknown> = {
  platformDestination: { kind: 'external' },
  withdraw: row,
  cancelWithdrawal: { ...row, status: 'failed', failureCode: 'withdrawal.canceled', holdReleased: true },
  getWithdrawal: row,
  withdrawalAllowance: {
    tier: 'full',
    assetId: 'USDC',
    base: figures,
    override: null,
    ...figures,
    used24h: '0',
    remaining: figures,
    maxNow: '1000',
  },
  withdrawalTierLimits: { enforced: true, limits: [{ tier: 'full', assetId: 'USDC', ...figures }] },
  searchWithdrawals: { items: [], next: null },
  quote,
  sql: [{ asset_id: 'USDC', network_id: 'ethereum', minimum: '1', maximum: '1000', step: '0.01', tag: 'none' }],
};
/** The service method each record's handler reaches; the refusal planted there is what the handler meets. */
const METHOD: Record<WithdrawalRecord['path'], string> = {
  'withdrawal.create': 'withdraw',
  'withdrawal.destination': 'platformDestination',
  'withdrawal.cancel': 'cancelWithdrawal',
  'withdrawal.get': 'getWithdrawal',
  'withdrawal.limits': 'withdrawalAllowance',
  'withdrawal.tierLimits': 'withdrawalTierLimits',
  'withdrawal.history': 'searchWithdrawals',
  'withdrawal.quote': 'quote',
  'withdrawal.networkRules': 'sql',
};

/** The typed error svc-pay makes each refusal from, by its code. A guard's kind is what its status says. */
function typedError(code: string, status: RefusalStatus): Error {
  if (code.startsWith('pay.guard_'))
    return new PayGuardRefusal(code as `pay.guard_${string}`, status === 'FORBIDDEN' ? 'refused' : 'unavailable');
  if (code.startsWith('withdrawal_quote.') || code === 'pay.fee_unset')
    return new WithdrawalQuoteError(code as WithdrawalQuoteErrorCode, code);
  if (code.startsWith('withdrawal_network_rules.')) return new WithdrawalNetworkRuleError(code as WithdrawalNetworkRuleErrorCode, code);
  if (code.startsWith('withdrawal_approval.')) return new WithdrawalApprovalError(code as WithdrawalApprovalErrorCode, code);
  return new PayError(`refused: ${code}`, code as PayErrorCode);
}

/** The one refusal the service throws next, by method; none means it answers. */
const next = new Map<string, Error>();
const answer = (method: string) => {
  const planted = next.get(method);
  if (planted) throw planted;
  return replies[method];
};
const service = <T>() => new Proxy({}, { get: (_target, method: string) => async () => answer(method) }) as T;
/** The pay database as the network rules read it: one query, answered or refused like a service method. */
const sql = Object.assign(async () => answer('sql'), { unsafe: undefined, json: undefined }) as Sql;

const rails = new RailRegistry([new CardSandboxAdapter({ secret: 'pay-withdrawal-samples-rail-secret-32-chars', toleranceSeconds: 300 })]);
const payRouter = createPayRouter(
  {} as PayService,
  rails,
  service<UserMoneyService>(),
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  sql,
  null,
  service<WithdrawalQuoteService>(),
);
const app = Fastify();

beforeAll(async () => {
  // A test stack, as the wire replay runs: the screening gate is not what these samples test.
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('PROCEDURE_REFUSALS_STRICT', '1');
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: payRouter, createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

async function send(record: WithdrawalRecord, input: unknown) {
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

type Mounted = { _def: { inputs: unknown[]; output?: unknown } };
const mounted = (path: string): Mounted | undefined =>
  (Reflect.get(Reflect.get(payRouter, '_def') as object, 'procedures') as Record<string, Mounted>)[path];

const HTTP: Record<RefusalStatus, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  TOO_MANY_REQUESTS: 429,
  SERVICE_UNAVAILABLE: 503,
};

const cases = PAY_WITHDRAWAL_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);
const refusals = PAY_WITHDRAWAL_PROCEDURES.flatMap((record) =>
  Object.entries(record.refusals).map(([code, status]) => ({ record, code, status, label: `${record.name} ${code}` })),
);

describe("svc-pay's withdrawal routes are mounted from their records", () => {
  it.each(PAY_WITHDRAWAL_PROCEDURES)('$name is mounted at its path with its own input and output', (record) => {
    expect(record.service).toBe('svc-pay');
    const procedure = mounted(record.path);
    expect(procedure, `${record.path} is not on the pay router`).toBeDefined();
    expect(procedure!._def.inputs).toContain(record.input);
    expect(procedure!._def.output).toBe(record.output);
  });

  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else expect(res.statusCode, res.body).toBe(200);
  });

  it.each(refusals)('$label leaves with the status its record names', async ({ record, code, status }) => {
    const accepted = record.samples.find((s: ProcedureSample) => s.verdict === 'accept')!;
    next.set(METHOD[record.path], typedError(code, status));
    try {
      const res = await send(record, accepted.input);
      expect(res.body).toContain(code);
      expect(res.statusCode, res.body).toBe(HTTP[status]);
    } finally {
      next.clear();
    }
  });

  it('a refusal the record does not list fails the strict check instead of leaving', async () => {
    next.set('getWithdrawal', new PayError('refused', 'pay.withdrawal_not_cancellable'));
    try {
      const res = await send(
        PAY_WITHDRAWAL_PROCEDURES.find((r) => r.path === 'withdrawal.get')!,
        { withdrawalId: ID },
      );
      expect(res.statusCode, res.body).toBe(500);
      expect(res.body).toContain('does not list it');
    } finally {
      next.clear();
    }
  });

  it("another account's withdrawal is refused, never shown", async () => {
    replies.getWithdrawal = { ...row, userId: '44444444-4444-4444-8444-444444444444' };
    try {
      const res = await send(
        PAY_WITHDRAWAL_PROCEDURES.find((r) => r.path === 'withdrawal.get')!,
        { withdrawalId: ID },
      );
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).not.toContain('44444444-4444-4444-8444-444444444444');
    } finally {
      replies.getWithdrawal = row;
    }
  });
});
