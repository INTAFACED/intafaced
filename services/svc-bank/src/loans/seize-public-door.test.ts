/**
 * Unit card — seize an underwater loan through ledger-client
 *
 * 1. Promise: ops.seizeLoan posts recipes.loanLiquidate. A missing mark
 *    refuses bank.mark_missing before any post. Split is computed from the
 *    mark and outstanding — no invented rate. Amounts stay decimal strings.
 * 2. Break: a silent default mark (zero / last / 1) would seize collateral
 *    nobody priced.
 * 3. Done bar: empty price source → PRECONDITION_FAILED / bank.mark_missing;
 *    no loan.liquidated. With a mark past insolvency, HTTP /trpc/ops.seizeLoan
 *    posts loan.liquidated.
 * 4. Class N
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts, router.ts (ops.seizeLoan)
 * 6. RED: pin fails if seize posts before marksFor, or if mark_missing is not
 *    on the operator door
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
import { MemoryLedger, marketMaker, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { stubApprovalConsumer } from '../action-approval-consume.js';
import { createBankRouter, type BankRouter } from '../router.js';
import { marketMakerVenue } from './loan-service.js';
import { fixedPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY } from './risk.js';
import { bankRouterSource } from '../router/router-source.js';

const SECRET = 'bank-loan-seize-missing-mark-secret-32b';
const BORROWER = '11111111-1111-4111-8111-111111111111';
const PAYER = '99999999-9999-4999-8999-999999999999';
const MM = '33333333-3333-4333-8333-333333333333';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;
const NOW = new Date('2026-06-01T12:00:00.000Z');

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

describe('seize pins marksFor before the ledger post', () => {
  it('seize asks for marks before loanLiquidate', () => {
    const src = readFileSync(join(here, 'loan-service.ts'), 'utf8');
    const seizeAt = src.indexOf('async seize(input:');
    const marksAt = src.indexOf('const marks = await this.marksFor(', seizeAt);
    const postAt = src.indexOf('this.liquidateTranche(', seizeAt);
    expect(seizeAt).toBeGreaterThan(-1);
    expect(marksAt).toBeGreaterThan(seizeAt);
    expect(postAt).toBeGreaterThan(marksAt);
    expect(src).toMatch(/bank\.mark_missing/);
  });

  it('operator door is ops.seizeLoan, not a user liquidate', () => {
    const src = bankRouterSource();
    expect(src).toMatch(/seizeLoan: scopedProcedure\('admin:treasury'/);
    expect(src).toMatch(/bank\.loans\.seize/);
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
    scopes: ['bank:read', 'bank:write', 'admin:treasury'],
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

function caller(bank: ReturnType<typeof createBankServices>, p: Principal = principal(), riskSweep = true) {
  const raw = encodePrincipal(p);
  return createBankRouter(bank, { loanRiskSweepEnabled: riskSweep, approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
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
  const router = createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) });
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

async function fundMm(ledger: MemoryLedger) {
  await fund(ledger, MM, 'USDT', '100000');
  await ledger.post({
    idempotencyKey: `seed-mm-${randomUUID()}`,
    module: 'test',
    reason: 'seed',
    entries: [
      { account: userAvailable(MM, 'USDT'), direction: 'credit', amount: amt('100000') },
      { account: marketMaker('USDT'), direction: 'debit', amount: amt('100000') },
    ],
  });
}

async function seedOpenLoan(bank: ReturnType<typeof createBankServices>, ledger: MemoryLedger, now: Date = NOW) {
  await fund(ledger, PAYER, 'USDT', '100000');
  await bank.loans.fundReserve({
    debtAssetId: 'USDT',
    fundingId: `f:${randomUUID()}`,
    amount: amt('100000'),
    from: userAvailable(PAYER, 'USDT'),
  });
  await fund(ledger, BORROWER, 'BTC', '1');
  await fundMm(ledger);
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
    now,
  });
}

describe('LoanService.seize refuses a missing mark before any post', () => {
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

  it('bank.mark_missing — no loan.liquidated', async () => {
    const openBank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: {
        originationFeeBps: '0',
        priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW),
        venue: marketMakerVenue(),
      },
    });
    const opened = await seedOpenLoan(openBank, ledger);
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({}, () => NOW), venue: marketMakerVenue() },
    });

    await expect(bank.loans.seize({ loanId: opened.loan.id, now: NOW })).rejects.toMatchObject({
      code: 'bank.mark_missing',
    });

    expect(ledger.journal().some((tx) => tx.reason === 'loan.liquidated')).toBe(false);
    expect(await sql`SELECT id FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}`).toHaveLength(0);
  });

  it('refuses seizure when the quote asset differs from the debt asset and posts nothing', async () => {
    const prices: Record<string, { price: string; quality: 'mid' }> = {
      BTC: { price: '10000', quality: 'mid' },
      USDT: { price: '1', quality: 'mid' },
    };
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource(prices, () => NOW), venue: marketMakerVenue() },
    });
    await fund(ledger, PAYER, 'USDT', '100000');
    await bank.loans.fundReserve({
      debtAssetId: 'USDT',
      fundingId: `f:${randomUUID()}`,
      amount: amt('100000'),
      from: userAvailable(PAYER, 'USDT'),
    });
    await fund(ledger, BORROWER, 'BTC', '1');
    await fundMm(ledger);
    const product = await bank.loans.createProduct({
      name: 'BTC marked in USD, borrowed in USDT',
      debtAssetId: 'USDT',
      collateralAssetId: 'BTC',
      quoteAssetId: 'USD',
      aprBps: 1_000,
      maxLtvBps: 5_000,
      minPrincipal: 0n,
      policy: DEFAULT_LIQUIDATION_POLICY,
    });
    const opened = await bank.loans.open({
      productId: product.id,
      userId: BORROWER,
      collateralAmount: amt('1'),
      principal: amt('5000'),
      now: NOW,
    });
    prices.BTC = { price: '5200', quality: 'mid' };
    const postsBeforeSeize = ledger.journal().length;

    await expect(bank.loans.seize({ loanId: opened.loan.id, now: NOW })).rejects.toMatchObject({
      code: 'bank.loan_seizure_cross_asset',
    });

    expect(ledger.journal().length).toBe(postsBeforeSeize);
    expect(ledger.journal().some((tx) => tx.reason === 'loan.liquidated')).toBe(false);
    expect(await sql`SELECT id FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}`).toHaveLength(0);
  });
});

describe('HTTP /trpc/ops.seizeLoan — seize through ledger-client', () => {
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

  it('refuses bank.mark_missing on the operator door and posts nothing', async () => {
    const openBank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: {
        originationFeeBps: '0',
        priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW),
        venue: marketMakerVenue(),
      },
    });
    const opened = await seedOpenLoan(openBank, ledger);
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({}, () => NOW), venue: marketMakerVenue() },
    });
    const app = await mountDoors(bank);

    await expect(caller(bank).ops.seizeLoan({ loanId: opened.loan.id, confirmOperatorId: CONFIRM, ...APPROVAL })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.mark_missing' },
    });

    const seized = await post(app, 'ops.seizeLoan', { loanId: opened.loan.id, confirmOperatorId: CONFIRM, ...APPROVAL });
    expect(seized.statusCode).toBe(412);
    expect(seized.body.error?.data?.code).toBe('PRECONDITION_FAILED');
    expect(JSON.stringify(seized.body.error)).toMatch(/bank\.mark_missing/);
    await app.close();

    expect(ledger.journal().some((tx) => tx.reason === 'loan.liquidated')).toBe(false);
  });

  it('with an insolvency mark, posts loan.liquidated — no invented rate', async () => {
    const prices: Record<string, { price: string; quality: 'mid' }> = { BTC: { price: '10000', quality: 'mid' } };
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource(prices), venue: marketMakerVenue() },
    });
    const opened = await seedOpenLoan(bank, ledger, new Date());
    prices.BTC = { price: '5200', quality: 'mid' };
    const app = await mountDoors(bank);

    const seized = await post(app, 'ops.seizeLoan', { loanId: opened.loan.id, confirmOperatorId: CONFIRM, ...APPROVAL });
    expect(seized.statusCode).toBe(200);
    const data = procedureData(seized.body) as {
      ledgerTxId: string;
      collateralSold: string;
      proceeds: string;
      principalRepaid: string;
      closed: boolean;
    };
    expect(data.ledgerTxId.length).toBeGreaterThan(0);
    expect(data.collateralSold).toMatch(/^\d+(\.\d+)?$/);
    expect(data.proceeds).toMatch(/^\d+(\.\d+)?$/);
    expect(data.principalRepaid).toMatch(/^\d+(\.\d+)?$/);
    expect(amt(data.collateralSold)).toBeGreaterThan(0n);
    await app.close();

    const journal = ledger.journal();
    const drawAt = journal.findIndex((tx) => tx.reason === 'loan.drawn');
    const liqAt = journal.findIndex((tx) => tx.reason === 'loan.liquidated');
    expect(drawAt).toBeGreaterThan(-1);
    expect(liqAt).toBeGreaterThan(drawAt);
  });
});
