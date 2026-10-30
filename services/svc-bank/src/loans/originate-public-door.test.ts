/**
 * Unit card — originate a loan through ledger-client; refuse a missing mark
 *
 * 1. Promise: loans.open posts lock then draw via recipes.loanCollateralLock /
 *    recipes.loanDraw. A missing mark refuses bank.mark_missing before any
 *    post. No invented rate. Amounts stay decimal strings.
 * 2. Break: a silent default mark (zero / last / 1) would let a borrower
 *    originate against collateral nobody priced — or the public door would
 *    swallow the refuse.
 * 3. Done bar: empty price source → PRECONDITION_FAILED / bank.mark_missing;
 *    no loan row; no loan.collateral.locked / loan.drawn. With a mark, HTTP
 *    /trpc/loans.open posts lock then draw.
 * 4. Class N
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts, router.ts (loans.open)
 * 6. RED: pin fails if open posts before marksFor, or if mark_missing is not
 *    on the public door
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

const SECRET = 'bank-loan-originate-mark-missing-secret-32b';
const BORROWER = '11111111-1111-4111-8111-111111111111';
const PAYER = '99999999-9999-4999-8999-999999999999';
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

describe('originate pins marksFor before the ledger posts', () => {
  it('open asks for marks before loanCollateralLock / loanDraw', () => {
    const src = readFileSync(join(here, 'loan-service.ts'), 'utf8');
    const openAt = src.indexOf('async open(input:');
    const marksAt = src.indexOf('await this.checkOpeningLtv(', openAt);
    const completeAt = src.indexOf('return this.completePending', openAt);
    expect(openAt).toBeGreaterThan(-1);
    expect(marksAt).toBeGreaterThan(openAt);
    expect(completeAt).toBeGreaterThan(marksAt);
    expect(src).toMatch(/recipes\.loanCollateralLock/);
    expect(src).toMatch(/recipes\.loanDraw/);
    expect(src).toMatch(/bank\.mark_missing/);
    // The marks themselves are read by the shared opening-LTV check.
    expect(src.indexOf('await this.marksFor(', src.indexOf('private async checkOpeningLtv('))).toBeGreaterThan(-1);
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

async function seedProduct(bank: ReturnType<typeof createBankServices>, ledger: MemoryLedger) {
  await fund(ledger, PAYER, 'USDT', '100000');
  await bank.loans.fundReserve({
    debtAssetId: 'USDT',
    fundingId: `f:${randomUUID()}`,
    amount: amt('100000'),
    from: userAvailable(PAYER, 'USDT'),
  });
  await fund(ledger, BORROWER, 'BTC', '1');
  return bank.loans.createProduct({
    name: 'BTC-backed USDT',
    debtAssetId: 'USDT',
    collateralAssetId: 'BTC',
    quoteAssetId: 'USDT',
    aprBps: 1_000,
    maxLtvBps: 5_000,
    minPrincipal: 0n,
    policy: DEFAULT_LIQUIDATION_POLICY,
  });
}

describe('LoanService.open refuses a missing mark before any post', () => {
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

  it('bank.mark_missing — no loan row, no lock, no draw', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({}, () => NOW) },
    });
    const product = await seedProduct(bank, ledger);

    await expect(
      bank.loans.open({
        productId: product.id,
        userId: BORROWER,
        collateralAmount: amt('1'),
        principal: amt('5000'),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'bank.mark_missing' });

    expect(await sql`SELECT id FROM bank.loans`).toHaveLength(0);
    expect(ledger.journal().some((tx) => tx.reason === 'loan.collateral.locked')).toBe(false);
    expect(ledger.journal().some((tx) => tx.reason === 'loan.drawn')).toBe(false);
    expect((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount).toBe(amt('1'));
    expect((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount).toBe(0n);
  });
});

describe('HTTP /trpc/loans.open — originate through ledger-client', () => {
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

  it('refuses bank.mark_missing on the public door and posts nothing', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const product = await seedProduct(bank, ledger);
    const app = await mountDoors(bank);

    const opened = await post(app, 'loans.open', {
      loanId: randomUUID(),
      productId: product.id,
      collateralAmount: '1',
      principal: '5000',
    });
    expect(opened.statusCode).toBe(412);
    const wire = JSON.stringify(opened.body.error);
    expect(opened.body.error?.data?.code).toBe('PRECONDITION_FAILED');
    expect(wire).toMatch(/bank\.mark_missing/);
    await app.close();

    expect(await sql`SELECT id FROM bank.loans`).toHaveLength(0);
    expect(ledger.journal().some((tx) => tx.reason === 'loan.collateral.locked')).toBe(false);
    expect(ledger.journal().some((tx) => tx.reason === 'loan.drawn')).toBe(false);
    expect((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount).toBe(amt('1'));
  });

  it('with a mark, posts lock then draw — no invented rate', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }) },
    });
    const product = await seedProduct(bank, ledger);
    const app = await mountDoors(bank);
    const loanId = randomUUID();

    const opened = await post(app, 'loans.open', {
      loanId,
      productId: product.id,
      collateralAmount: '1',
      principal: '5000',
    });
    expect(opened.statusCode).toBe(200);
    const data = procedureData(opened.body) as { loanId: string; status: string; drawLedgerTxId: string };
    expect(data.loanId).toBe(loanId);
    expect(data.status).toBe('active');
    expect(data.drawLedgerTxId.length).toBeGreaterThan(0);
    await app.close();

    const journal = ledger.journal();
    const lockAt = journal.findIndex((tx) => tx.reason === 'loan.collateral.locked');
    const drawAt = journal.findIndex((tx) => tx.reason === 'loan.drawn');
    expect(lockAt).toBeGreaterThan(-1);
    expect(drawAt).toBeGreaterThan(lockAt);
    expect((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount).toBe(amt('5000'));
    expect((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount).toBe(0n);
  });
});
