/**
 * BK-loan-05: `loans.releasable`, the redeem-excess read, agrees with the release cap. Harness from release-excess-once.test.ts.
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
import { MemoryLedger, parseAmount as amt, recipes, userAvailable, type PostRequest } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter, type BankRouter } from '../router.js';
import { fixedPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY } from './risk.js';

const SECRET = 'bank-loan-releasable-read-secret-32ch';
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

async function seedOpenLoan(bank: ReturnType<typeof createBankServices>, ledger: MemoryLedger, collateral: string, now: Date = NOW) {
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

function caller(bank: ReturnType<typeof createBankServices>, p: Principal = principal()) {
  return createBankRouter(bank).createCaller(
    edgeContext({ headers: signedHeaders(p), id: `req-${randomUUID()}` } as unknown as Parameters<typeof edgeContext>[0]),
  );
}

describe('loans.releasable (BK-loan-05)', () => {
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

  function services(marks: Parameters<typeof fixedPriceSource>[0]) {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource(marks, () => new Date()) },
    });
  }

  it('answers exactly what releaseExcess allows: one unit more is refused, the amount itself posts, then nothing is left', async () => {
    const bank = services({ BTC: { price: '10000', quality: 'mid' } });
    // TEST figures: 3 BTC at 10000, debt 5000, max LTV 50%, so 1 BTC must stay.
    const opened = await seedOpenLoan(bank, ledger, '3', new Date());
    const me = caller(bank);
    expect(await me.loans.releasable({ loanId: opened.loan.id })).toEqual({
      loanId: opened.loan.id,
      held: '3',
      releasable: '2',
      maxLtvBps: 5_000,
      ltvBps: 1_667,
    });

    await expect(
      bank.loans.releaseExcess({ loanId: opened.loan.id, eventId: randomUUID(), amount: amt('2.000000000000000001') }),
    ).rejects.toMatchObject({ code: 'bank.ltv_exceeded' });
    await bank.loans.releaseExcess({ loanId: opened.loan.id, eventId: randomUUID(), amount: amt('2') });
    expect(await me.loans.releasable({ loanId: opened.loan.id })).toMatchObject({ held: '1', releasable: '0', ltvBps: 5_000 });
  });

  it('is zero, not negative, when the loan is already above the cap', async () => {
    const bank = services({ BTC: { price: '10000', quality: 'mid' } });
    const opened = await seedOpenLoan(bank, ledger, '3', new Date());
    const fallen = services({ BTC: { price: '2000', quality: 'mid' } });
    expect(await caller(fallen).loans.releasable({ loanId: opened.loan.id })).toMatchObject({ releasable: '0', ltvBps: 8_334 });
  });

  it('refuses with no usable mark, for another user, and for an unknown loan', async () => {
    const bank = services({ BTC: { price: '10000', quality: 'mid' } });
    const opened = await seedOpenLoan(bank, ledger, '3', new Date());
    const blind = services({});
    await expect(caller(blind).loans.releasable({ loanId: opened.loan.id })).rejects.toMatchObject({
      message: expect.stringContaining('No usable mark'),
    });
    const stranger = principal({ sub: PAYER, userId: PAYER });
    await expect(caller(bank, stranger).loans.releasable({ loanId: opened.loan.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(bank).loans.releasable({ loanId: randomUUID() })).rejects.toThrow();
    expect(ledger.journal().filter((tx) => tx.reason === 'loan.collateral.released')).toHaveLength(0);
  });

  it('refuses on a pending loan', async () => {
    const bank = services({ BTC: { price: '10000', quality: 'mid' } });
    const opened = await seedOpenLoan(bank, ledger, '3', new Date());
    await sql`UPDATE bank.loans SET status = 'pending' WHERE id = ${opened.loan.id}`;
    await expect(bank.loans.releasable(opened.loan.id)).rejects.toMatchObject({ code: 'bank.loan_not_drawable' });
  });
});
