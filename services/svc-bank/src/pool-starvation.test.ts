/**
 * Unit card — a full pool of overlapping money requests does not freeze svc-bank
 *
 * 1. Promise: POOL requests that each need a lock AND a second connection finish
 *    on a pool of exactly POOL connections. Repays on different loans,
 *    liquidations of different loans, and overlapping scheduled-transfer passes
 *    all complete. The advisory lock key is the one the old code took.
 * 2. Break: a request held one connection (the session lock's reserved
 *    connection, or the claim transaction) and then waited for a second one from
 *    the SAME pool. postgres.js waits with no timeout, so once POOL such requests
 *    overlapped, no body could open its transaction and no lock holder could
 *    finish. The pool froze until restart (GitHub issue #4621). CI saw it as
 *    "eight runs race" hanging 119 of 146 tests.
 * 3. Done bar: every case below finishes inside DEADLINE_MS on a REAL pool whose
 *    `max` equals the number of racers. A frozen pool fails the case at the
 *    deadline instead of hanging the run.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/session-lock.ts, loans/loan-service.ts,
 *    ramps/ramp-service.ts, transfers/transfer-service.ts
 * 6. RED: before the fix the repay and liquidation cases hit the deadline (every
 *    pool connection is an idle lock holder) and the transfer case hits it (every
 *    pool connection is a claim transaction, one of them waiting for a
 *    connection to read a space on).
 *
 * `holdUntilAll` makes the overlap deterministic. Without it the racers happen
 * to stagger and the old code passes by luck, which is how it got to CI green
 * with a pool of 8 and eight racers once and froze the next run.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, marketMaker, parseAmount as amt, recipes, userAvailable, formatAmount } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from './analytics/ledger-history.js';
import { createBankServices } from './bank-service.js';
import { marketMakerVenue } from './loans/loan-service.js';
import { fixedPriceSource } from './loans/prices.js';
import { DEFAULT_LIQUIDATION_POLICY } from './loans/risk.js';
import { withSessionAdvisoryLock } from './session-lock.js';

/** Pool size AND number of racers. The old code freezes at exactly this ratio. */
const POOL = 4;
const DEADLINE_MS = 15_000;
const PAYER = '99999999-9999-4999-8999-999999999999';
const MM = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-06-01T12:00:00.000Z');

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

let db: TestDatabase;
/** A real pool of POOL connections: the thing that froze. */
let pool: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
}, 120_000);

/** A fresh pool per case: a frozen one must not poison the cases after it. */
beforeEach(() => {
  pool = postgres(db.url, {
    max: POOL,
    connection: { search_path: 'bank,public' },
    onnotice: () => undefined,
  });
});

afterEach(async () => {
  // timeout 0: a frozen pool has reserved connections that never drain.
  await pool?.end({ timeout: 0 }).catch(() => undefined);
});

afterAll(async () => {
  await db?.drop();
}, 30_000);

/** Fail at the deadline instead of hanging the run, which is what a frozen pool would do. */
async function within<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: still waiting after ${DEADLINE_MS}ms — the pool is frozen`)), DEADLINE_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A rendezvous: the first `racers` callers wait for each other (or `graceMs`,
 * so a design that lets fewer through at a time still makes progress).
 */
function rendezvous(racers: number, graceMs = 400) {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= racers) open();
    await Promise.race([opened, new Promise<void>((resolve) => setTimeout(resolve, graceMs))]);
  };
}

async function fund(ledger: MemoryLedger, userId: string, assetId: string, value: string) {
  await ledger.post(
    recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: `${userId}:${assetId}:${randomUUID()}` }),
  );
}

async function truncate() {
  await db.sql`
    TRUNCATE bank.loan_liquidations, bank.loan_margin_calls, bank.loan_repayments,
             bank.loan_interest_accruals, bank.loan_collateral_events, bank.loans, bank.loan_products,
             bank.loan_reserve_fundings,
             bank.transfer_executions, bank.scheduled_transfers, bank.spaces
    RESTART IDENTITY CASCADE
  `;
}

describe('svc-bank — a pool full of overlapping money requests does not freeze', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await truncate();
    ledger = new MemoryLedger();
  });

  async function openLoans(count: number, prices: Record<string, { price: string; quality: 'mid' }>) {
    const bank = createBankServices(pool, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource(prices), venue: marketMakerVenue() },
    });
    await fund(ledger, PAYER, 'USDT', '1000000');
    await bank.loans.fundReserve({
      debtAssetId: 'USDT',
      fundingId: `f:${randomUUID()}`,
      amount: amt('1000000'),
      from: userAvailable(PAYER, 'USDT'),
    });
    await fund(ledger, MM, 'USDT', '1000000');
    await ledger.post({
      idempotencyKey: `seed-mm-${randomUUID()}`,
      module: 'test',
      reason: 'seed',
      entries: [
        { account: userAvailable(MM, 'USDT'), direction: 'credit', amount: amt('1000000') },
        { account: marketMaker('USDT'), direction: 'debit', amount: amt('1000000') },
      ],
    });
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
    const loans = [];
    for (let i = 0; i < count; i++) {
      const userId = randomUUID();
      await fund(ledger, userId, 'BTC', '1');
      loans.push(
        await bank.loans.open({
          productId: product.id,
          userId,
          collateralAmount: amt('1'),
          principal: amt('5000'),
          now: new Date(),
        }),
      );
    }
    return { bank, loans };
  }

  it(`${POOL} concurrent repays on ${POOL} different loans all complete on a pool of ${POOL}`, async () => {
    const { bank, loans } = await openLoans(POOL, { BTC: { price: '10000', quality: 'mid' } });

    // Every racer reserves its lock connection, then waits for the others.
    // Old code: all POOL connections are now idle lock holders and no body can
    // open its claim transaction.
    const meet = rendezvous(POOL);
    const reserve = pool.reserve.bind(pool);
    pool.reserve = (async () => {
      const reserved = await reserve();
      await meet();
      return reserved;
    }) as typeof pool.reserve;

    try {
      const results = await within(
        'repay',
        Promise.all(loans.map((l) => bank.loans.repay({ loanId: l.loan.id, amount: amt('100'), eventId: randomUUID() }))),
      );
      expect(results).toHaveLength(POOL);
      expect(ledger.journal().filter((tx) => tx.reason === 'loan.repaid')).toHaveLength(POOL);
    } finally {
      pool.reserve = reserve;
    }
  }, 30_000);

  it(`${POOL} concurrent liquidations of ${POOL} different loans all complete on a pool of ${POOL}`, async () => {
    const prices: Record<string, { price: string; quality: 'mid' }> = { BTC: { price: '10000', quality: 'mid' } };
    const { bank, loans } = await openLoans(POOL, prices);
    prices.BTC = { price: '5200', quality: 'mid' };

    const meet = rendezvous(POOL);
    const reserve = pool.reserve.bind(pool);
    pool.reserve = (async () => {
      const reserved = await reserve();
      await meet();
      return reserved;
    }) as typeof pool.reserve;

    try {
      await within('liquidate', Promise.all(loans.map((l) => bank.loans.seize({ loanId: l.loan.id }))));
      expect(ledger.journal().filter((tx) => tx.reason === 'loan.liquidated')).toHaveLength(POOL);
    } finally {
      pool.reserve = reserve;
    }
  }, 30_000);

  it(`${POOL} overlapping runDueTransfers passes in one process do not freeze a pool of ${POOL}, and the transfer fires once`, async () => {
    const bank = createBankServices(pool, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
    const user = randomUUID();
    const primary = await bank.spaces.ensurePrimary(user, 'USDT');
    const rent = await bank.spaces.create({ userId: user, assetId: 'USDT', name: 'Rent' });
    await bank.transfers.schedule({
      scheduleId: randomUUID(),
      userId: user,
      fromSpaceId: primary.id,
      toSpaceId: rent.id,
      amount: amt('100'),
      cadence: 'monthly',
      startsAt: new Date('2026-01-01T09:00:00Z'),
    });
    await fund(ledger, user, 'USDT', '1000');

    // Every pass opens its claim transaction at the same moment. Old code: one
    // pass holds the schedule row, the other passes queue on it, each holding a
    // connection, and the holder needs one more connection to read a space.
    const meet = rendezvous(POOL);
    const begin = pool.begin.bind(pool);
    pool.begin = (async (...args: unknown[]) => {
      await meet();
      return (begin as (...a: unknown[]) => unknown)(...args);
    }) as typeof pool.begin;

    try {
      const now = new Date('2026-01-01T10:00:00Z');
      const reports = await within(
        'runDueTransfers',
        Promise.all(Array.from({ length: POOL }, () => bank.transfers.runDueTransfers({ now, limit: 200 }))),
      );
      // One pass owns the occurrence. Nobody fires it twice, nobody fails.
      expect(reports.reduce((n, r) => n + r.settled, 0)).toBe(1);
      expect(reports.flatMap((r) => r.failures)).toEqual([]);
      expect(formatAmount((await ledger.balance(userAvailable(user, 'USDT'))).amount)).toBe('900');
      expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('bank.transfer.sched:'))).toHaveLength(1);
    } finally {
      pool.begin = begin;
    }

    // A pass that lost the race did not consume the schedule's watermark: a
    // later pass finds nothing owed because the first one finished it.
    const later = await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 200 });
    expect(later.settled).toBe(0);
  }, 30_000);
});

describe('withSessionAdvisoryLock — the lock is the one the old code took', () => {
  it('takes pg_advisory_lock(hashtext(namespace), hashtext(key)) on a reserved session, and releases it', async () => {
    const key = randomUUID();
    const peek = async () =>
      db.sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND granted
           AND classid = hashtext('bank.loan.repay')::oid AND objid = hashtext(${key})::oid
      `;

    let during = -1;
    await withSessionAdvisoryLock(pool, 'bank.loan.repay', key, async () => {
      during = (await peek())[0]!.n;
    });
    expect(during).toBe(1);
    expect((await peek())[0]!.n).toBe(0);
  });

  it('excludes a second holder of the same key, including one on another pool (another replica)', async () => {
    const other = postgres(db.url, { max: POOL, connection: { search_path: 'bank,public' }, onnotice: () => undefined });
    try {
      const key = randomUUID();
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });

      const first = withSessionAdvisoryLock(pool, 'bank.loan.liquidate', key, async () => {
        order.push('first in');
        entered();
        await held;
        order.push('first out');
      });
      await inside;
      const second = withSessionAdvisoryLock(other, 'bank.loan.liquidate', key, async () => {
        order.push('second in');
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(order).toEqual(['first in']);
      release();
      await within('exclusion', Promise.all([first, second]));
      expect(order).toEqual(['first in', 'first out', 'second in']);
    } finally {
      await other.end({ timeout: 0 });
    }
  });

  it('releases the lock and the connection when the body throws', async () => {
    const key = randomUUID();
    await expect(
      withSessionAdvisoryLock(pool, 'bank.ramp.offramp', key, async () => {
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    // Same key again must not wait: the lock was released.
    await within(
      'reacquire',
      withSessionAdvisoryLock(pool, 'bank.ramp.offramp', key, async () => 'ok'),
    );
  });

  it('refuses a pool of one rather than hanging: the body could never borrow a connection', async () => {
    const one = postgres(db.url, { max: 1, onnotice: () => undefined });
    try {
      await expect(withSessionAdvisoryLock(one, 'bank.loan.repay', randomUUID(), async () => 'x')).rejects.toThrow(
        /DATABASE_POOL_MAX >= 2/,
      );
    } finally {
      await one.end({ timeout: 0 });
    }
  });

  it('more lock holders than the pool can spare queue without holding a connection', async () => {
    const many = POOL * 3;
    const meet = rendezvous(many);
    const results = await within(
      'queue',
      Promise.all(
        Array.from({ length: many }, (_, i) =>
          withSessionAdvisoryLock(pool, 'bank.loan.repay', `queue-${i}-${randomUUID()}`, async () => {
            await meet();
            // The body borrows a SECOND connection from the same pool.
            return pool.begin(async (tx) => (await tx<Array<{ one: number }>>`SELECT 1 AS one`)[0]!.one);
          }),
        ),
      ),
    );
    expect(results).toEqual(Array.from({ length: many }, () => 1));
  }, 30_000);
});
