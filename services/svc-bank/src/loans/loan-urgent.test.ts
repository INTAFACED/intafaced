/**
 * Unit card: loan engine urgent fixes (N4, N5, N18)
 *
 * 1. N4: a loan already in margin call is not re-notified by each later sweep.
 *    A failed delivery is retried on the same call row, never as a new call.
 * 2. N5: a ticker body with no timestamp gives no mark (a stale price must not
 *    be stamped fresh).
 * 3. N18: a same-id retry of an unbooked excess release re-checks the LTV cap
 *    against a fresh mark before it re-drives the post.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable, type PostRequest } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { fixedPriceSource, tickerPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY } from './risk.js';

const BORROWER = '11111111-1111-4111-8111-111111111111';
const PAYER = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_000);

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;

afterAll(async () => {
  await db.drop();
}, 30_000);

const price = (btc: string, at: () => Date = () => NOW) => fixedPriceSource({ BTC: { price: btc, quality: 'mid' } }, at);

function releaseCount(ledger: MemoryLedger): number {
  return ledger.journal().filter((tx) => tx.reason === 'loan.collateral.released').length;
}

function isRelease(request: PostRequest): boolean {
  return request.reason === 'loan.collateral.released';
}

type Sent = { loanId: string; sequence: number };

async function reset(): Promise<MemoryLedger> {
  await sql`
    TRUNCATE bank.loan_liquidations, bank.loan_margin_calls, bank.loan_repayments,
             bank.loan_interest_accruals, bank.loan_collateral_events, bank.loans, bank.loan_products,
             bank.loan_reserve_fundings
    RESTART IDENTITY CASCADE
  `;
  return new MemoryLedger();
}

async function seedOpenLoan(bank: ReturnType<typeof createBankServices>, ledger: MemoryLedger, collateral: string, now: Date = NOW) {
  await ledger.post(
    recipes.deposit({ userId: PAYER, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: `${PAYER}:${randomUUID()}` }),
  );
  await bank.loans.fundReserve({
    debtAssetId: 'USDT',
    fundingId: `f:${randomUUID()}`,
    amount: amt('100000'),
    from: userAvailable(PAYER, 'USDT'),
  });
  await ledger.post(
    recipes.deposit({ userId: BORROWER, assetId: 'BTC', amount: amt(collateral), rail: 'test', railRef: `${BORROWER}:${randomUUID()}` }),
  );
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

describe('N4: margin-call notice is sent once per call, not once per sweep', () => {
  it('a second sweep on a loan already in margin call sends nothing and adds no call row', async () => {
    const ledger = await reset();
    const opener = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: price('10000') },
    });
    const opened = await seedOpenLoan(opener, ledger, '1');

    const sent: Sent[] = [];
    const sweeper = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: {
        originationFeeBps: '0',
        priceSource: price('6500', () => LATER),
        marginCalls: { send: async (i) => void sent.push({ loanId: i.loanId, sequence: i.sequence }) },
      },
    });

    await sweeper.loans.runRiskSweep({ now: LATER, limit: 100 });
    await sweeper.loans.runRiskSweep({ now: LATER, limit: 100 });
    await sweeper.loans.runRiskSweep({ now: LATER, limit: 100 });

    const rows = await sql`SELECT sequence FROM bank.loan_margin_calls WHERE loan_id = ${opened.loan.id}`;
    expect(sent).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect((await sweeper.loans.loan(opened.loan.id)).status).toBe('margin_call');
  });

  it('a notice that failed is re-sent on the SAME call row, then stops', async () => {
    const ledger = await reset();
    const opener = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: price('10000') },
    });
    const opened = await seedOpenLoan(opener, ledger, '1');

    const sent: Sent[] = [];
    let fail = true;
    const sweeper = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: {
        originationFeeBps: '0',
        priceSource: price('6500', () => LATER),
        marginCalls: {
          send: async (i) => {
            sent.push({ loanId: i.loanId, sequence: i.sequence });
            if (fail) throw new Error('bus down');
          },
        },
      },
    });

    await sweeper.loans.runRiskSweep({ now: LATER, limit: 100 });
    fail = false;
    await sweeper.loans.runRiskSweep({ now: LATER, limit: 100 });
    await sweeper.loans.runRiskSweep({ now: LATER, limit: 100 });

    const rows = await sql<Array<{ sequence: number; notified_at: Date | null }>>`
      SELECT sequence, notified_at FROM bank.loan_margin_calls WHERE loan_id = ${opened.loan.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notified_at).not.toBeNull();
    expect(sent.map((s) => s.sequence)).toEqual([rows[0]!.sequence, rows[0]!.sequence]);
  });
});

describe('N4: a crash between the call row and the loan update heals on the next sweep', () => {
  it('sets margin_called_at from the open call row, without re-sending a delivered notice', async () => {
    const ledger = await reset();
    const opener = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: price('10000') },
    });
    const opened = await seedOpenLoan(opener, ledger, '1');

    // The state after a crash: the call row is written (and delivered), the loan row is not updated.
    await sql`
      INSERT INTO bank.loan_margin_calls (loan_id, sequence, ltv_bps, cure_collateral_amount, called_at, grace_expires_at, notified_at)
      VALUES (${opened.loan.id}, 0, 7700, 0.1, ${NOW}, ${new Date(NOW.getTime() + 3_600_000)}, ${NOW})
    `;
    expect((await opener.loans.loan(opened.loan.id)).marginCalledAt).toBeNull();

    const sent: Sent[] = [];
    const sweeper = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: {
        originationFeeBps: '0',
        priceSource: price('6500', () => LATER),
        marginCalls: { send: async (i) => void sent.push({ loanId: i.loanId, sequence: i.sequence }) },
      },
    });
    await sweeper.loans.runRiskSweep({ now: LATER, limit: 100 });

    const loan = await sweeper.loans.loan(opened.loan.id);
    expect(loan.status).toBe('margin_call');
    expect(loan.marginCalledAt?.getTime()).toBe(NOW.getTime());
    expect(sent).toHaveLength(0);
    expect(await sql`SELECT 1 FROM bank.loan_margin_calls WHERE loan_id = ${opened.loan.id}`).toHaveLength(1);
  });
});

describe('N5: a ticker with no timestamp gives no mark', () => {
  it('omits the mark instead of stamping it with the current time', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ bid: '9990', ask: '10010', last: '10000' }), { status: 200 })) as unknown as typeof fetch;
    const source = tickerPriceSource({ baseUrl: 'http://trade.test', fetchImpl });
    const marks = await source.marks(['BTC'], 'USDT');
    expect(marks.has('BTC')).toBe(false);
  });

  it('still returns a mark when the ticker states its own time', async () => {
    const stamp = NOW.getTime();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ bid: '9990', ask: '10010', last: '10000', timestamp: stamp }), {
        status: 200,
      })) as unknown as typeof fetch;
    const marks = await tickerPriceSource({ baseUrl: 'http://trade.test', fetchImpl }).marks(['BTC'], 'USDT');
    expect(marks.get('BTC')?.asOf.getTime()).toBe(stamp);
  });
});

describe('N18: a same-id retry of an unbooked release re-checks the LTV cap', () => {
  it('refuses the re-drive after the price fell, and posts nothing', async () => {
    const ledger = await reset();
    const rich = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: price('10000') },
    });
    // 3 BTC at 10000, debt 5000, cap 50%: releasing 2 BTC leaves exactly the cap.
    const opened = await seedOpenLoan(rich, ledger, '3');
    const eventId = randomUUID();

    const innerPost = ledger.post.bind(ledger);
    let dropped = false;
    ledger.post = async (request) => {
      if (!dropped && isRelease(request)) {
        dropped = true;
        throw new Error('connection reset before the ledger committed');
      }
      return innerPost(request);
    };
    await expect(rich.loans.releaseExcess({ loanId: opened.loan.id, eventId, amount: amt('2'), now: NOW })).rejects.toThrow(
      /connection reset/,
    );
    expect(releaseCount(ledger)).toBe(0);

    // The price falls. Releasing 2 BTC now would leave 1 BTC at 6000 against 5000 of debt.
    const poor = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: price('6000', () => LATER) },
    });
    await expect(poor.loans.releaseExcess({ loanId: opened.loan.id, eventId, amount: amt('2'), now: LATER })).rejects.toMatchObject({
      code: 'bank.ltv_exceeded',
    });
    expect(releaseCount(ledger)).toBe(0);
  });

  it('still re-drives the same release when the cap still holds', async () => {
    const ledger = await reset();
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: price('10000') },
    });
    const opened = await seedOpenLoan(bank, ledger, '3');
    const eventId = randomUUID();

    const innerPost = ledger.post.bind(ledger);
    let dropped = false;
    ledger.post = async (request) => {
      if (!dropped && isRelease(request)) {
        dropped = true;
        throw new Error('connection reset before the ledger committed');
      }
      return innerPost(request);
    };
    await expect(bank.loans.releaseExcess({ loanId: opened.loan.id, eventId, amount: amt('2'), now: NOW })).rejects.toThrow(
      /connection reset/,
    );
    const retry = await bank.loans.releaseExcess({ loanId: opened.loan.id, eventId, amount: amt('2'), now: NOW });
    expect(retry.ledgerTxId.length).toBeGreaterThan(0);
    expect(releaseCount(ledger)).toBe(1);
  });
});
