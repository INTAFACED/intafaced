/**
 * Unit card — loan repay retry is one loanRepay (caller eventId)
 *
 * 1. Promise: repay requires eventId. Retry of the same eventId posts
 *    recipes.loanRepay once. Sequence is MAX+1 only for a new event.
 * 2. Break: no client id + nextSequence MAX+1 makes a retry a second loanRepay.
 *    Hashing loanId+amount merges two genuine same-amount payments.
 * 3. Done bar: two repay() same eventId → one loan.repaid. HTTP omit is 400.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts, router.ts (loans.repay)
 * 6. RED: two same-eventId repays post twice; source has no eventId before nextSequence
 * 7. Collision: add-collateral-retry-id — this file does not touch lockCollateral
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

const SECRET = 'bank-loan-repay-retry-id-secret-32!!!';
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

describe('repay pins eventId before MAX+1 sequence allocation', () => {
  it('repay requires eventId before nextSequence and does not mint', () => {
    const src = readFileSync(join(here, 'loan-service.ts'), 'utf8');
    const repayAt = src.indexOf('async repay(input:');
    const seizeAt = src.indexOf('async seize(input:', repayAt);
    const body = src.slice(repayAt, seizeAt);
    expect(repayAt).toBeGreaterThan(-1);
    expect(body).toMatch(/eventId/);
    expect(body).toMatch(/bank\.repayment_id_required/);
    expect(body).toMatch(/repaymentById/);
    expect(body).not.toMatch(/randomUUID/);
    const lookupAt = body.indexOf('repaymentById');
    const nextAt = body.indexOf('nextSequence');
    expect(lookupAt).toBeGreaterThan(-1);
    expect(nextAt).toBeGreaterThan(lookupAt);
  });

  it('public door requires eventId so omit is not a second loanRepay', () => {
    const src = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    const doorAt = src.indexOf("repay: scopedProcedure('bank:write'");
    const closeAt = src.indexOf("close: scopedProcedure('bank:write'", doorAt);
    const body = src.slice(doorAt, closeAt === -1 ? doorAt + 1800 : closeAt);
    expect(doorAt).toBeGreaterThan(-1);
    expect(body).toMatch(/eventId:\s*z\.string\(\)\.uuid\(\)/);
    expect(body).not.toMatch(/eventId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
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
      createContext: ({ req }) => edgeContext({ headers: req.headers, id: req.id }),
    } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
  });
  await app.ready();
  return app;
}

async function post(app: FastifyInstance, path: string, input: Record<string, unknown>): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'POST', url: `/trpc/${path}`, headers: signedHeaders(), payload: input });
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

async function seedOpenLoan(bank: ReturnType<typeof createBankServices>, ledger: MemoryLedger, now: Date = NOW) {
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

function repayCount(ledger: MemoryLedger): number {
  return ledger.journal().filter((tx) => tx.reason === 'loan.repaid').length;
}

describe('LoanService.repay — timed-out retry is one loanRepay', () => {
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

  it('omit eventId refuses bank.repayment_id_required and posts nothing', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const opened = await seedOpenLoan(bank, ledger);
    await expect(bank.loans.repay({ loanId: opened.loan.id, amount: amt('1000'), eventId: '', now: NOW })).rejects.toMatchObject({
      code: 'bank.repayment_id_required',
    });
    expect(repayCount(ledger)).toBe(0);
  });

  it('two repays of the same eventId — one loan.repaid', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const opened = await seedOpenLoan(bank, ledger);
    const eventId = randomUUID();

    const first = await bank.loans.repay({ loanId: opened.loan.id, amount: amt('1000'), eventId, now: NOW });
    const retry = await bank.loans.repay({ loanId: opened.loan.id, amount: amt('1000'), eventId, now: NOW });

    expect(retry.ledgerTxId).toBe(first.ledgerTxId);
    expect(retry.sequence).toBe(first.sequence);
    expect(repayCount(ledger)).toBe(1);
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM bank.loan_repayments WHERE loan_id = ${opened.loan.id} AND status = 'settled'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(eventId);
  });

  it('timeout after repay posts, retry same eventId — one loan.repaid', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const opened = await seedOpenLoan(bank, ledger);
    const eventId = randomUUID();

    const innerPost = ledger.post.bind(ledger);
    let timedOut = false;
    ledger.post = async (request) => {
      const posted = await innerPost(request);
      if (!timedOut && request.reason === 'loan.repaid') {
        timedOut = true;
        throw new Error('timed out after repay posted');
      }
      return posted;
    };

    await expect(bank.loans.repay({ loanId: opened.loan.id, amount: amt('1000'), eventId, now: NOW })).rejects.toThrow(
      /timed out after repay posted/,
    );
    expect(repayCount(ledger)).toBe(1);

    const retry = await bank.loans.repay({ loanId: opened.loan.id, amount: amt('1000'), eventId, now: NOW });
    expect(retry.ledgerTxId.length).toBeGreaterThan(0);
    expect(repayCount(ledger)).toBe(1);
  });

  it('two eventIds of the same amount are two repayments', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const opened = await seedOpenLoan(bank, ledger);
    const first = await bank.loans.repay({
      loanId: opened.loan.id,
      amount: amt('1000'),
      eventId: randomUUID(),
      now: NOW,
    });
    const second = await bank.loans.repay({
      loanId: opened.loan.id,
      amount: amt('1000'),
      eventId: randomUUID(),
      now: NOW,
    });
    expect(second.sequence).not.toBe(first.sequence);
    expect(repayCount(ledger)).toBe(2);
  });
});

describe('HTTP /trpc/loans.repay — retry with the same eventId is one loanRepay', () => {
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

  it('HTTP without eventId is 400', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }) },
    });
    const opened = await seedOpenLoan(bank, ledger, new Date());
    const app = await mountDoors(bank);
    const omitted = await post(app, 'loans.repay', { loanId: opened.loan.id, amount: '1000' });
    expect(omitted.statusCode).toBe(400);
    await app.close();
    expect(repayCount(ledger)).toBe(0);
  });

  it('two HTTP posts with the same eventId are one loan.repaid', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }) },
    });
    const opened = await seedOpenLoan(bank, ledger, new Date());
    const eventId = randomUUID();
    const app = await mountDoors(bank);

    const first = await post(app, 'loans.repay', { loanId: opened.loan.id, amount: '1000', eventId });
    expect(first.statusCode).toBe(200);
    const firstData = procedureData(first.body) as { ledgerTxId: string };

    const retry = await post(app, 'loans.repay', { loanId: opened.loan.id, amount: '1000', eventId });
    expect(retry.statusCode).toBe(200);
    const retryData = procedureData(retry.body) as { ledgerTxId: string };
    expect(retryData.ledgerTxId).toBe(firstData.ledgerTxId);
    await app.close();

    expect(repayCount(ledger)).toBe(1);
  });
});
