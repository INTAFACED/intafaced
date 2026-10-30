/**
 * Unit card — addCollateral retry is one lock (client eventId)
 *
 * 1. Promise: a timed-out or overlapping loans.addCollateral retry with the same
 *    eventId and amount posts recipes.loanCollateralLock once. Sequence is MAX+1
 *    only for a new event; the client id is the retry key. The overlap loser posts
 *    the claimed row's sequence (ledger key is loanId:sequence).
 * 2. Break: overlapping retries allocate different MAX+1 sequences; ON CONFLICT
 *    (id) still posts the caller's sequence and double-locks. Requiring eventId
 *    400s leftover Loans.vue `{loanId, amount}`. Minting UUID when omitted makes
 *    a retry without a stable client id a second lock.
 * 3. Done bar: two overlapping addCollateral same eventId + amount → one extra
 *    lock. Timeout-after-post serial retry is still one lock. HTTP without
 *    eventId is 400. Amount mismatch refuses bank.loan_collateral_mismatch.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts, router.ts (addCollateral)
 * 6. RED: overlapping same eventId posts two loan.collateral.locked; HTTP
 *    `{loanId, amount}` is 400
 * 7. Collision: night #2681 Bank.vue; closed #2698 amountFromSql mill — this
 *    file does not touch either
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
import { bankRouterSource } from '../router/router-source.js';

const SECRET = 'bank-loan-add-collateral-retry-id-secret32';
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

describe('addCollateral pins eventId before MAX+1 sequence allocation', () => {
  it('addCollateral resolves the client event id before nextCollateralSequence and does not mint', () => {
    const src = readFileSync(join(here, 'loan-service.ts'), 'utf8');
    const addAt = src.indexOf('async addCollateral(input:');
    const relAt = src.indexOf('async releaseExcess(input:', addAt);
    const body = src.slice(addAt, relAt);
    expect(addAt).toBeGreaterThan(-1);
    expect(body).toMatch(/eventId/);
    expect(body).toMatch(/bank\.event_id_required/);
    expect(body).not.toMatch(/randomUUID/);
    const lookupAt = body.indexOf('collateralEventById');
    const nextAt = body.indexOf('nextCollateralSequence');
    expect(lookupAt).toBeGreaterThan(-1);
    expect(nextAt).toBeGreaterThan(lookupAt);
    expect(src).toMatch(/FROM bank\.loan_collateral_events WHERE id =/);
  });

  it('lockCollateral posts the claimed row sequence after ON CONFLICT (id)', () => {
    const src = readFileSync(join(here, 'loan-service.ts'), 'utf8');
    const lockAt = src.indexOf('private async lockCollateral(');
    const relAt = src.indexOf('private async releaseCollateral(', lockAt);
    const body = src.slice(lockAt, relAt);
    expect(lockAt).toBeGreaterThan(-1);
    expect(body).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    expect(body).not.toMatch(/ON CONFLICT \(loan_id, sequence\)/);
    expect(body).toMatch(/let postSequence = sequence/);
    expect(body).toMatch(/postSequence = Number\(row\.sequence\)/);
    expect(body).toMatch(/sequence: postSequence/);
  });

  it('public door requires eventId so omit is not a second loanCollateralLock', () => {
    const src = bankRouterSource();
    const doorAt = src.indexOf("addCollateral: scopedProcedure('bank:write'");
    const relAt = src.indexOf("releaseExcess: scopedProcedure('bank:write'", doorAt);
    const body = src.slice(doorAt, relAt);
    expect(doorAt).toBeGreaterThan(-1);
    expect(body).toMatch(/eventId:\s*z\.string\(\)\.guid\(\)/);
    expect(body).not.toMatch(/eventId:\s*z\.string\(\)\.guid\(\)\.optional\(\)/);
    expect(body).toMatch(/eventId:\s*input\.eventId/);
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

async function seedOpenLoan(bank: ReturnType<typeof createBankServices>, ledger: MemoryLedger, now: Date = NOW) {
  await fund(ledger, PAYER, 'USDT', '100000');
  await bank.loans.fundReserve({
    debtAssetId: 'USDT',
    fundingId: `f:${randomUUID()}`,
    amount: amt('100000'),
    from: userAvailable(PAYER, 'USDT'),
  });
  // Three BTC: one to open, one for the top-up, one leftover so a buggy retry
  // can actually post a second lock instead of failing insufficient-funds.
  await fund(ledger, BORROWER, 'BTC', '3');
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

function lockCount(ledger: MemoryLedger): number {
  return ledger.journal().filter((tx) => tx.reason === 'loan.collateral.locked').length;
}

function isTopUpLock(request: PostRequest): boolean {
  const sequence = request.meta && typeof request.meta === 'object' ? Number((request.meta as { sequence?: unknown }).sequence) : NaN;
  return request.reason === 'loan.collateral.locked' && sequence > 0;
}

describe('LoanService.addCollateral — timed-out retry is one lock', () => {
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

  it('omit eventId refuses bank.event_id_required and posts nothing', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const opened = await seedOpenLoan(bank, ledger);
    const locksAtOpen = lockCount(ledger);
    await expect(bank.loans.addCollateral({ loanId: opened.loan.id, eventId: '', amount: amt('1'), now: NOW })).rejects.toMatchObject({
      code: 'bank.event_id_required',
    });
    expect(lockCount(ledger)).toBe(locksAtOpen);
  });

  it('timeout after lock posts, retry same eventId + amount — one extra lock, not two', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const opened = await seedOpenLoan(bank, ledger);
    const locksAtOpen = lockCount(ledger);
    const eventId = randomUUID();

    const innerPost = ledger.post.bind(ledger);
    let timedOut = false;
    ledger.post = async (request) => {
      const posted = await innerPost(request);
      if (!timedOut && isTopUpLock(request)) {
        timedOut = true;
        throw new Error('timed out after lock posted');
      }
      return posted;
    };

    await expect(bank.loans.addCollateral({ loanId: opened.loan.id, eventId, amount: amt('1'), now: NOW })).rejects.toThrow(
      /timed out after lock posted/,
    );
    expect(timedOut).toBe(true);
    expect(lockCount(ledger)).toBe(locksAtOpen + 1);

    const retry = await bank.loans.addCollateral({ loanId: opened.loan.id, eventId, amount: amt('1'), now: NOW });
    expect(retry.sequence).toBeGreaterThan(0);
    expect(retry.ledgerTxId.length).toBeGreaterThan(0);

    expect(lockCount(ledger)).toBe(locksAtOpen + 1);
    const events = await sql<Array<{ id: string; sequence: number; direction: string }>>`
      SELECT id, sequence, direction FROM bank.loan_collateral_events
       WHERE loan_id = ${opened.loan.id} AND direction = 'lock'
       ORDER BY sequence
    `;
    expect(events).toHaveLength(2);
    expect(events.filter((e) => e.sequence > 0)).toHaveLength(1);
    expect(events.some((e) => e.id === eventId)).toBe(true);
    expect((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount).toBe(amt('1'));
  });

  it.each(['first', 'second'] as const)(
    'two overlapping addCollateral with the same eventId lock once (%s promise is held)',
    async (heldCaller) => {
      const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
      });
      const opened = await seedOpenLoan(bank, ledger);
      const locksAtOpen = lockCount(ledger);
      const eventId = randomUUID();

      type Sequencer = { nextCollateralSequence: (loanId: string) => Promise<number> };
      const loans = bank.loans as unknown as Sequencer;
      if (typeof loans.nextCollateralSequence !== 'function') {
        throw new Error('nextCollateralSequence missing — overlap harness cannot force distinct sequences');
      }
      const origNext = loans.nextCollateralSequence.bind(bank.loans);
      let nextHits = 0;
      let firstAtNext!: () => void;
      const firstReachedNext = new Promise<void>((resolve) => {
        firstAtNext = resolve;
      });
      let bothAtNext!: () => void;
      const bothReachedNext = new Promise<void>((resolve) => {
        bothAtNext = resolve;
      });
      let loserMayAllocate!: () => void;
      const loserAllowed = new Promise<void>((resolve) => {
        loserMayAllocate = resolve;
      });
      loans.nextCollateralSequence = async (loanId: string) => {
        const place = ++nextHits;
        if (place === 1) firstAtNext();
        if (place === 2) bothAtNext();
        await bothReachedNext;
        if (place === 1) return origNext(loanId);
        await loserAllowed;
        return origNext(loanId);
      };

      const innerPost = ledger.post.bind(ledger);
      let firstTopUpSeen = false;
      let releaseFirstPost!: () => void;
      const firstPostHeld = new Promise<void>((resolve) => {
        releaseFirstPost = resolve;
      });
      ledger.post = async (request) => {
        if (!firstTopUpSeen && isTopUpLock(request)) {
          firstTopUpSeen = true;
          loserMayAllocate();
          await firstPostHeld;
        }
        return innerPost(request);
      };

      const arrivingFirst = bank.loans.addCollateral({ loanId: opened.loan.id, eventId, amount: amt('1'), now: NOW });
      await firstReachedNext;
      const arrivingSecond = bank.loans.addCollateral({ loanId: opened.loan.id, eventId, amount: amt('1'), now: NOW });
      const [first, second] = heldCaller === 'first' ? [arrivingFirst, arrivingSecond] : [arrivingSecond, arrivingFirst];
      // The held post belongs to whichever call reaches the sequencer first.
      // Waiting for a named caller can wait on that very post under CI scheduling.
      // The other retry can finish the shared claim; release the held post once
      // either caller completes, then compare both receipts and all money facts.
      try {
        await Promise.race([first, second]);
      } finally {
        releaseFirstPost();
      }
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.sequence).toBe(secondResult.sequence);
      expect(firstResult.ledgerTxId).toBe(secondResult.ledgerTxId);
      expect(lockCount(ledger)).toBe(locksAtOpen + 1);
      const events = await sql<Array<{ id: string; sequence: number }>>`
      SELECT id, sequence FROM bank.loan_collateral_events
       WHERE loan_id = ${opened.loan.id} AND sequence > 0
    `;
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe(eventId);
      expect((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount).toBe(amt('1'));
    },
    20_000,
  );

  it('same eventId with a different amount refuses and does not post a second lock', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const opened = await seedOpenLoan(bank, ledger);
    const eventId = randomUUID();
    const first = await bank.loans.addCollateral({ loanId: opened.loan.id, eventId, amount: amt('1'), now: NOW });
    const locksAfter = lockCount(ledger);

    await expect(bank.loans.addCollateral({ loanId: opened.loan.id, eventId, amount: amt('0.5'), now: NOW })).rejects.toMatchObject({
      code: 'bank.loan_collateral_mismatch',
    });

    expect(lockCount(ledger)).toBe(locksAfter);
    const retry = await bank.loans.addCollateral({ loanId: opened.loan.id, eventId, amount: amt('1'), now: NOW });
    expect(retry.ledgerTxId).toBe(first.ledgerTxId);
    expect(retry.sequence).toBe(first.sequence);
    expect(lockCount(ledger)).toBe(locksAfter);
  });
});

describe('HTTP /trpc/loans.addCollateral — retry with the same eventId is one lock', () => {
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

  it('two HTTP posts with the same eventId and amount lock once', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }) },
    });
    const opened = await seedOpenLoan(bank, ledger, new Date());
    const locksAtOpen = lockCount(ledger);
    const eventId = randomUUID();
    const app = await mountDoors(bank);

    const first = await post(app, 'loans.addCollateral', { loanId: opened.loan.id, eventId, amount: '1' });
    expect(first.statusCode).toBe(200);
    const firstData = procedureData(first.body) as { ledgerTxId: string; sequence: number };

    const retry = await post(app, 'loans.addCollateral', { loanId: opened.loan.id, eventId, amount: '1' });
    expect(retry.statusCode).toBe(200);
    const retryData = procedureData(retry.body) as { ledgerTxId: string; sequence: number };
    expect(retryData.ledgerTxId).toBe(firstData.ledgerTxId);
    expect(retryData.sequence).toBe(firstData.sequence);
    await app.close();

    expect(lockCount(ledger)).toBe(locksAtOpen + 1);
    const events = await sql<Array<{ id: string }>>`
      SELECT id FROM bank.loan_collateral_events WHERE loan_id = ${opened.loan.id} AND sequence > 0
    `;
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(eventId);
  });

  it('HTTP without eventId is 400', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }) },
    });
    const opened = await seedOpenLoan(bank, ledger, new Date());
    const locksAtOpen = lockCount(ledger);
    const app = await mountDoors(bank);

    const omitted = await post(app, 'loans.addCollateral', { loanId: opened.loan.id, amount: '1' });
    expect(omitted.statusCode).toBe(400);
    await app.close();

    expect(lockCount(ledger)).toBe(locksAtOpen);
  });
});
