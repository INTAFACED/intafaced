/**
 * Unit card — one collateral release, held under the cap
 *
 * 1. Promise: a retry of the same releaseExcess (same eventId and amount) posts
 *    recipes.loanCollateralRelease once. Two overlapping releases that each fit
 *    the product cap do not both post when together they would sit above it.
 * 2. Break: releaseExcess takes no caller event id, allocates MAX+1 on every
 *    call, and checks max LTV before the release is claimed. A timed-out retry
 *    posts a second loanCollateralRelease. Two overlapping releases each pass.
 * 3. Done bar: timeout-after-post with the same eventId is one
 *    loan.collateral.released. Two concurrent releases of the capped headroom:
 *    one posts, the other refuses bank.ltv_exceeded. Amounts stay decimal strings.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts, router.ts (releaseExcess)
 * 6. RED: retry posts a second loan.collateral.released; both overlapping
 *    callers fulfill
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

const SECRET = 'bank-loan-release-excess-once-secret32';
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

function releaseCount(ledger: MemoryLedger): number {
  return ledger.journal().filter((tx) => tx.reason === 'loan.collateral.released').length;
}

function isRelease(request: PostRequest): boolean {
  return request.reason === 'loan.collateral.released';
}

describe('LoanService.releaseExcess — one release, cap held across callers', () => {
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

  it('timeout after the release posts, retry same eventId and amount — one loanCollateralRelease', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    // 3 BTC at 10000, debt 5000, max LTV 50%: up to 2 BTC may leave. A second
    // 0.5 still fits the cap, so a fresh sequence would post again.
    const opened = await seedOpenLoan(bank, ledger, '3');
    const eventId = randomUUID();

    const innerPost = ledger.post.bind(ledger);
    let timedOut = false;
    ledger.post = async (request) => {
      const posted = await innerPost(request);
      if (!timedOut && isRelease(request)) {
        timedOut = true;
        throw new Error('timed out after release posted');
      }
      return posted;
    };

    await expect(bank.loans.releaseExcess({ loanId: opened.loan.id, eventId, amount: amt('0.5'), now: NOW })).rejects.toThrow(
      /timed out after release posted/,
    );
    expect(releaseCount(ledger)).toBe(1);

    const retry = await bank.loans.releaseExcess({ loanId: opened.loan.id, eventId, amount: amt('0.5'), now: NOW });
    expect(retry.ledgerTxId.length).toBeGreaterThan(0);
    expect(retry.sequence).toBeGreaterThan(0);
    expect(releaseCount(ledger)).toBe(1);
    expect((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount).toBe(amt('0.5'));
  });

  it('two overlapping releases of the capped headroom do not both pass', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    // 2 BTC, debt 5000 at 10000, max LTV 50%. Releasing 1 leaves LTV at the cap.
    // A second 1 leaves nothing pledged. Each call alone is allowed.
    const opened = await seedOpenLoan(bank, ledger, '2');
    const eventA = randomUUID();
    const eventB = randomUUID();

    const innerPost = ledger.post.bind(ledger);
    let parked = false;
    let releasePark!: () => void;
    const park = new Promise<void>((resolve) => {
      releasePark = resolve;
    });
    ledger.post = async (request) => {
      if (!parked && isRelease(request)) {
        parked = true;
        await park;
      }
      return innerPost(request);
    };

    const noteSettled = () => {
      // Resolving before the park starts is safe: the later await returns at
      // once. The cap decision has already committed with the ledger unmoved.
      releasePark();
    };
    const results = await Promise.allSettled([
      bank.loans.releaseExcess({ loanId: opened.loan.id, eventId: eventA, amount: amt('1'), now: NOW }).finally(noteSettled),
      bank.loans.releaseExcess({ loanId: opened.loan.id, eventId: eventB, amount: amt('1'), now: NOW }).finally(noteSettled),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'bank.ltv_exceeded' });
    expect(releaseCount(ledger)).toBe(1);
    expect((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount).toBe(amt('1'));
  }, 20_000);
});

describe('HTTP /trpc/loans.releaseExcess — same event is one release', () => {
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

  it('two HTTP posts with the same eventId and amount release once', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }) },
    });
    const opened = await seedOpenLoan(bank, ledger, '3', new Date());
    const eventId = randomUUID();
    const app = await mountDoors(bank);

    const first = await post(app, 'loans.releaseExcess', { loanId: opened.loan.id, eventId, amount: '0.5' });
    expect(first.statusCode).toBe(200);
    const retry = await post(app, 'loans.releaseExcess', { loanId: opened.loan.id, eventId, amount: '0.5' });
    expect(retry.statusCode).toBe(200);
    await app.close();

    expect(releaseCount(ledger)).toBe(1);
    expect((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount).toBe(amt('0.5'));
  });

  it('HTTP without eventId is 400 and posts nothing', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }) },
    });
    const opened = await seedOpenLoan(bank, ledger, '3', new Date());
    const app = await mountDoors(bank);

    const omitted = await post(app, 'loans.releaseExcess', { loanId: opened.loan.id, amount: '0.5' });
    expect(omitted.statusCode).toBe(400);
    await app.close();

    expect(releaseCount(ledger)).toBe(0);
  });
});
