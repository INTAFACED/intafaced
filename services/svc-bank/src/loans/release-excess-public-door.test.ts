/**
 * Unit card — release excess collateral through ledger-client
 *
 * 1. Promise: loans.releaseExcess posts recipes.loanCollateralRelease. A missing
 *    loan refuses bank.loan_not_found. A missing mark refuses bank.mark_missing
 *    before any post. After-release LTV uses the mark and the product cap — no
 *    invented rate. Amounts stay decimal strings.
 * 2. Break: peeling collateral off a guessed id or an unpriced book would
 *    unsecure a loan nobody can mark.
 * 3. Done bar: unknown loanId → NOT_FOUND / bank.loan_not_found; empty price
 *    source → PRECONDITION_FAILED / bank.mark_missing; no loan.collateral.released.
 *    With a mark and remaining LTV at the cap, HTTP /trpc/loans.releaseExcess
 *    posts the release.
 * 4. Class N
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts, router.ts (releaseExcess)
 * 6. RED: pin fails if releaseExcess posts before this.loan() / marksFor
 * 7. Collision: #2194 compose quote-asset pin — this file does not touch
 *    compose, env.ts, or LOAN_QUOTE_ASSET_ID
 * 8. Re-attach CI after prettier wrap; re-tip past protocol onchain flake.
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

const SECRET = 'bank-loan-release-excess-mark-secret-32b';
const BORROWER = '11111111-1111-4111-8111-111111111111';
const PAYER = '99999999-9999-4999-8999-999999999999';
const MISSING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

describe('releaseExcess pins loan load and marks before the release', () => {
  it('releaseExcess loads the loan, then marks, then releaseCollateral', () => {
    const src = readFileSync(join(here, 'loan-service.ts'), 'utf8');
    const relAt = src.indexOf('async releaseExcess(input:');
    const loadAt = src.indexOf('const loan = await this.loan(input.loanId)', relAt);
    const marksAt = src.indexOf('await this.marksFor(', relAt);
    const postAt = src.indexOf('this.releaseCollateral(', relAt);
    expect(relAt).toBeGreaterThan(-1);
    expect(loadAt).toBeGreaterThan(relAt);
    expect(marksAt).toBeGreaterThan(loadAt);
    expect(postAt).toBeGreaterThan(marksAt);
    expect(src).toMatch(/bank\.loan_not_found/);
    expect(src).toMatch(/bank\.mark_missing/);
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

async function seedOpenLoan(bank: ReturnType<typeof createBankServices>, ledger: MemoryLedger, now: Date = NOW, collateral = '2') {
  await fund(ledger, PAYER, 'USDT', '100000');
  await bank.loans.fundReserve({
    debtAssetId: 'USDT',
    fundingId: `f:${randomUUID()}`,
    amount: amt('100000'),
    from: userAvailable(PAYER, 'USDT'),
  });
  await fund(ledger, BORROWER, 'BTC', collateral);
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
    collateralAmount: amt(collateral),
    principal: amt('5000'),
    now,
  });
}

describe('LoanService.releaseExcess refuses missing loan or mark before any post', () => {
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

  it('bank.loan_not_found — no loan.collateral.released', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });

    await expect(bank.loans.releaseExcess({ loanId: MISSING, eventId: randomUUID(), amount: amt('1'), now: NOW })).rejects.toMatchObject({
      code: 'bank.loan_not_found',
    });

    expect(ledger.journal().some((tx) => tx.reason === 'loan.collateral.released')).toBe(false);
  });

  it('bank.mark_missing — no release', async () => {
    const openBank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const opened = await seedOpenLoan(openBank, ledger);
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({}, () => NOW) },
    });

    await expect(
      bank.loans.releaseExcess({ loanId: opened.loan.id, eventId: randomUUID(), amount: amt('1'), now: NOW }),
    ).rejects.toMatchObject({
      code: 'bank.mark_missing',
    });

    expect(ledger.journal().some((tx) => tx.reason === 'loan.collateral.released')).toBe(false);
  });
});

describe('HTTP /trpc/loans.releaseExcess — peel through ledger-client', () => {
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
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const app = await mountDoors(bank);

    await expect(caller(bank).loans.releaseExcess({ loanId: MISSING, eventId: randomUUID(), amount: '1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      cause: { code: 'bank.loan_not_found' },
    });

    const released = await post(app, 'loans.releaseExcess', { loanId: MISSING, eventId: randomUUID(), amount: '1' });
    expect(released.statusCode).toBe(404);
    expect(released.body.error?.data?.code).toBe('NOT_FOUND');
    await app.close();

    expect(ledger.journal().some((tx) => tx.reason === 'loan.collateral.released')).toBe(false);
  });

  it('refuses bank.mark_missing on the public door and posts nothing', async () => {
    const openBank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const opened = await seedOpenLoan(openBank, ledger);
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({}, () => NOW) },
    });
    const app = await mountDoors(bank);

    await expect(caller(bank).loans.releaseExcess({ loanId: opened.loan.id, eventId: randomUUID(), amount: '1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.mark_missing' },
    });

    const released = await post(app, 'loans.releaseExcess', { loanId: opened.loan.id, eventId: randomUUID(), amount: '1' });
    expect(released.statusCode).toBe(412);
    expect(released.body.error?.data?.code).toBe('PRECONDITION_FAILED');
    expect(JSON.stringify(released.body.error)).toMatch(/bank\.mark_missing/);
    await app.close();

    expect(ledger.journal().some((tx) => tx.reason === 'loan.collateral.released')).toBe(false);
  });

  it('with a mark, posts loan.collateral.released — no invented rate', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }) },
    });
    const opened = await seedOpenLoan(bank, ledger, new Date(), '2');
    const app = await mountDoors(bank);

    const released = await post(app, 'loans.releaseExcess', { loanId: opened.loan.id, eventId: randomUUID(), amount: '1' });
    expect(released.statusCode).toBe(200);
    const data = procedureData(released.body) as { ledgerTxId: string; sequence: number };
    expect(data.ledgerTxId.length).toBeGreaterThan(0);
    expect(data.sequence).toBeGreaterThanOrEqual(0);
    await app.close();

    expect(ledger.journal().some((tx) => tx.reason === 'loan.collateral.released')).toBe(true);
    expect((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount).toBe(amt('1'));
  });
});
