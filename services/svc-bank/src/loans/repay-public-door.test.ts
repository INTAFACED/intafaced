/**
 * Unit card — repay a loan through ledger-client; refuse a missing loan
 *
 * 1. Promise: loans.repay posts recipes.loanRepay. A missing loan refuses
 *    bank.loan_not_found before any post. Split is computed from outstanding —
 *    no invented rate. Amounts stay decimal strings.
 * 2. Break: a repay against a guessed id would post or invent a residual.
 * 3. Done bar: unknown loanId → NOT_FOUND / bank.loan_not_found; no
 *    loan.repaid. With a live loan, HTTP /trpc/loans.repay posts loan.repaid.
 * 4. Class N
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts, router.ts (loans.repay)
 * 6. RED: pin fails if repay posts before this.loan(), or if a missing id
 *    is not refused on the public door
 * 7. Collision: #2194 compose quote-asset pin — this file does not touch
 *    compose, env.ts, or LOAN_QUOTE_ASSET_ID
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter, type BankRouter } from '../router.js';
import { fixedPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY } from './risk.js';
import { bankRouterSource } from '../router/router-source.js';

const SECRET = 'bank-loan-repay-missing-secret-32bytes!!';
const BORROWER = '11111111-1111-4111-8111-111111111111';
const PAYER = '99999999-9999-4999-8999-999999999999';
const MISSING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

describe('repay pins loan load before the ledger post', () => {
  it('repay loads the loan before recipes.loanRepay', () => {
    const src = readFileSync(join(here, 'loan-service.ts'), 'utf8');
    const repayAt = src.indexOf('async repay(input:');
    const loadAt = src.indexOf('const loan = await this.loan(input.loanId)', repayAt);
    const postAt = src.indexOf('recipes.loanRepay', repayAt);
    expect(repayAt).toBeGreaterThan(-1);
    expect(loadAt).toBeGreaterThan(repayAt);
    expect(postAt).toBeGreaterThan(loadAt);
    expect(src).toMatch(/bank\.loan_not_found/);
  });

  it('public door looks up the loan before repay', () => {
    const src = bankRouterSource();
    const doorAt = src.indexOf("repay: scopedProcedure('bank:write'");
    const loadAt = src.indexOf('const loan = await bank.loans.loan(input.loanId)', doorAt);
    const repayAt = src.indexOf('bank.loans.repay', doorAt);
    expect(doorAt).toBeGreaterThan(-1);
    expect(loadAt).toBeGreaterThan(doorAt);
    expect(repayAt).toBeGreaterThan(loadAt);
  });
});

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

afterAll(async () => {
  await db.drop();
}, 30_000);

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: BORROWER,
    userId: BORROWER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
    'content-type': 'application/json',
  };
}

function caller(bank: ReturnType<typeof createBankServices>, p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return createBankRouter(bank).createCaller(
    edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

async function mountDoors(bank: ReturnType<typeof createBankServices>): Promise<FastifyInstance> {
  const router = createBankRouter(bank);
  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
  });
  await app.ready();
  return app;
}

async function post(
  app: FastifyInstance,
  path: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'POST', url: `/trpc/${path}`, headers, payload: input });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

function procedureData(body: WireBody): unknown {
  const data = body.result?.data;
  if (data && typeof data === 'object' && data !== null && 'json' in data) {
    return (data as { json: unknown }).json;
  }
  return data;
}

async function fund(ledger: MemoryLedger, userId: string, assetId: string, value: string) {
  await ledger.post(
    recipes.deposit({
      userId,
      assetId,
      amount: amt(value),
      rail: 'test',
      railRef: `${userId}:${assetId}:${randomUUID()}`,
    }),
  );
}

async function seedOpenLoan(bank: ReturnType<typeof createBankServices>, ledger: MemoryLedger) {
  await fund(ledger, PAYER, 'USDT', '100000');
  await bank.loans.fundReserve({
    debtAssetId: 'USDT',
    fundingId: `f:${randomUUID()}`,
    amount: amt('100000'),
    from: userAvailable(PAYER, 'USDT'),
  });
  await fund(ledger, BORROWER, 'BTC', '1');
  const product = await bank.loans.createProduct({
    name: 'BTC-backed USDT',
    debtAssetId: 'USDT',
    collateralAssetId: 'BTC',
    quoteAssetId: 'USDT',
    aprBps: 1_000,
    maxLtvBps: 5_000,
    minPrincipal: 0n,
    policy: DEFAULT_LIQUIDATION_POLICY,
  });
  return bank.loans.open({
    productId: product.id,
    userId: BORROWER,
    collateralAmount: amt('1'),
    principal: amt('5000'),
  });
}

describe('LoanService.repay refuses a missing loan before any post', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.loan_liquidations, bank.loan_margin_calls, bank.loan_repayments,
               bank.loan_interest_accruals, bank.loan_collateral_events, bank.loans, bank.loan_products,
               bank.loan_reserve_fundings
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  it('bank.loan_not_found — no loan.repaid', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));

    await expect(bank.loans.repay({ eventId: randomUUID(), loanId: MISSING, amount: amt('1') })).rejects.toMatchObject({
      code: 'bank.loan_not_found',
    });

    expect(ledger.journal().some((tx) => tx.reason === 'loan.repaid')).toBe(false);
  });
});

describe('HTTP /trpc/loans.repay — repay through ledger-client', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.loan_liquidations, bank.loan_margin_calls, bank.loan_repayments,
               bank.loan_interest_accruals, bank.loan_collateral_events, bank.loans, bank.loan_products,
               bank.loan_reserve_fundings
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  it('refuses bank.loan_not_found on the public door and posts nothing', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const app = await mountDoors(bank);

    await expect(caller(bank).loans.repay({ eventId: randomUUID(), loanId: MISSING, amount: '1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      cause: { code: 'bank.loan_not_found' },
    });

    const opened = await post(app, 'loans.repay', { loanId: MISSING, amount: '1', eventId: randomUUID() });
    expect(opened.statusCode).toBe(404);
    expect(opened.body.error?.data?.code).toBe('NOT_FOUND');
    await app.close();

    expect(ledger.journal().some((tx) => tx.reason === 'loan.repaid')).toBe(false);
  });

  it('with a live loan, posts loan.repaid — no invented rate', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }) },
    });
    const opened = await seedOpenLoan(bank, ledger);
    const app = await mountDoors(bank);

    const repaid = await post(app, 'loans.repay', { loanId: opened.loan.id, amount: '1000', eventId: randomUUID() });
    expect(repaid.statusCode).toBe(200);
    const data = procedureData(repaid.body) as {
      ledgerTxId: string;
      interestPaid: string;
      principalPaid: string;
      remainingPrincipal: string;
      closed: boolean;
    };
    expect(data.ledgerTxId.length).toBeGreaterThan(0);
    expect(data.interestPaid).toBe('0');
    expect(data.principalPaid).toBe('1000');
    expect(data.remainingPrincipal).toBe('4000');
    expect(data.closed).toBe(false);
    await app.close();

    const journal = ledger.journal();
    const drawAt = journal.findIndex((tx) => tx.reason === 'loan.drawn');
    const repayAt = journal.findIndex((tx) => tx.reason === 'loan.repaid');
    expect(drawAt).toBeGreaterThan(-1);
    expect(repayAt).toBeGreaterThan(drawAt);
    expect((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount).toBe(amt('4000'));
  });
});
