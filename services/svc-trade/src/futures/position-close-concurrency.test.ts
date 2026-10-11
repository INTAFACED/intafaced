import { PositionService } from '../controls/test-admission.js';
/**
 * CONCURRENT AND REPLAYED CLOSES PAY REALISED PROFIT EXACTLY ONCE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS FILE EXISTS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `close()` used to run: `SELECT … status='open'` → read the mark → bound check
 * → `ledger.post` × N → `UPDATE … status='closed'`. No lock, no transaction, and
 * an idempotency key minted per ATTEMPT rather than per CLOSE:
 *
 *     closeId: `close:${row.id}:${randomUUID()}`
 *
 * `futuresRealizeProfit` keys on `futures.profit:${profitId}`, so a fresh UUID
 * meant the ledger could not dedupe and every concurrent attempt was a genuinely
 * new payout. `futuresMarginRelease` keys on `positionId:sequence` and WAS
 * deduped — which is why only the payout multiplied, and why counting HTTP 200s
 * would have looked fine.
 *
 * Eight concurrent DELETEs on one position paid 5000 of honest PnL eight times.
 * The payout bound did not save it: each attempt read the pot's balance BEFORE
 * any of them had drained it, so the bound capped the theft at the pot's total
 * balance rather than at the honest PnL. It is the ADR's own sentence failing in
 * a new disguise — the party being paid still chose the amount, this time via N
 * instead of via `exitPrice`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE MARK IS SLOW HERE, AND WHY THAT IS NOT A RIGGED TEST
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The race needs a yield between reading the row and writing it. In production
 * there is always a wide one: `markFor()` is an HTTP round trip to the venue
 * fabric or the matching book. A memory mark book resolves immediately and
 * leaves only the microtask boundaries — measured against the unfixed service,
 * that was still enough to double-pay two concurrent closes (110000 instead of
 * 105000), but nothing like enough to interleave eight reliably.
 *
 * `slowMarks()` puts 25 ms back, and with it the real shape: eight concurrent
 * closes paid 5000 eight times over (140000), and sixteen drained the pot to the
 * floor (150000, +50000 — the entire pot). 25 ms is not a pessimistic number for
 * an HTTP round trip, it is a generous one.
 *
 * ASSERTIONS ARE BALANCES, never response codes. A duplicate payout is a number
 * in the ledger; a 200 is an opinion about one.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  houseFees,
  parseAmount as amt,
  positionCollateralAccount,
  recipes,
  userAvailable,
} from '@intafaced/ledger-client';
import type { LedgerClient, PostRequest } from '@intafaced/ledger-client';

import { memoryMarkBook } from './mark-source.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';
import type { QuotedMarkSource } from './liquidation-tick.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-trade position-close-concurrency is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
/** Somebody else's realised loss is how the profit pot actually fills. */
const BOB = '22222222-2222-4222-8222-222222222222';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** A second futures market — `positions_open_unique_idx` is one open row per user per market. */
const MARKET_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-08-06T12:00:00.000Z');

/** The round trip production always has and a memory book never does. */
function slowMarks(inner: QuotedMarkSource, delayMs: number): QuotedMarkSource {
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    async quote(input) {
      await wait();
      return inner.quote(input);
    },
    async markPrice(input) {
      await wait();
      return inner.markPrice(input);
    },
  };
}

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade position-close-concurrency (H8a PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  let ledger: MemoryLedger;
  let marks: ReturnType<typeof memoryMarkBook>;
  /**
   * Every post the service made, in order.
   *
   * A DEDUPED post still returns a transaction, so counting calls would not
   * distinguish "paid twice" from "asked twice and paid once". Counting DISTINCT
   * idempotency keys does: one key is one transaction in the book, which is one
   * payout.
   */
  let posted: PostRequest[] = [];

  const profitPot = () => houseFees('trade', 'USDT');
  const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));

  function feed(price: string, marketId: string = MARKET) {
    marks.set({ marketId, price, quality: 'mid', asOfMs: NOW.getTime() });
  }

  /** A service whose mark port takes `delayMs` to answer — 0 for the instant case. */
  function build(delayMs: number) {
    const source = delayMs > 0 ? slowMarks(marks.source(), delayMs) : marks.source();
    const recording: LedgerClient = {
      post: (request: PostRequest) => {
        posted.push(request);
        return ledger.post(request);
      },
      balance: ledger.balance.bind(ledger),
      balances: ledger.balances.bind(ledger),
      getTx: ledger.getTx.bind(ledger),
      getTxByKey: ledger.getTxByKey.bind(ledger),
    };
    return new PositionService(sql, recording, {
      marks: source,
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus: null,
      now: () => NOW,
    });
  }

  /** Three real recipes, no fixture poking a balance in — the pot is a real balance. */
  async function fundProfitSource(amount: string) {
    const seed = `pot-seed-${randomUUID()}`;
    await ledger.post(recipes.deposit({ userId: BOB, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: `pot-${randomUUID()}` }));
    await ledger.post(recipes.futuresMarginLock({ positionId: seed, userId: BOB, assetId: 'USDT', amount: amt(amount) }));
    await ledger.post(
      recipes.futuresRealizeLoss({
        positionId: seed,
        userId: BOB,
        assetId: 'USDT',
        fromMargin: amt(amount),
        fromInsurance: 0n,
        lossId: seed,
      }),
    );
  }

  const balance = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);

  beforeEach(async () => {
    await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    marks = memoryMarkBook();
    posted = [];
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, 'BTC/USDT-PERP', 'BTC', 'USDT', 'futures',
        '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now()
      )
    `;
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: `fund-${randomUUID()}` }),
    );
    // A pot far larger than the honest PnL: if the bound were the only control,
    // it would happily fund ten duplicate payouts before it noticed.
    await fundProfitSource('50000');
  });

  /**
   * Open 1 BTC long at 50000 on 10x — margin 5000 — and move the feed to 55000.
   * Honest realised PnL is 5000 and there is exactly one of it.
   */
  async function openWinner(service: PositionService) {
    feed('50000');
    const pos = await service.open({
      clientOpenId: 't-open-position-close-concurrency.test-1',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    feed('55000');
    return pos;
  }

  /** The books after exactly one honest close of the position above. */
  async function expectPaidExactlyOnce(positionId: string) {
    // 100000 − 5000 margin + 5000 margin back + 5000 profit.
    expect(await balance(userAvailable(ALICE, 'USDT'))).toBe('105000');
    // The pot funded 5000 of profit, once.
    expect(await balance(profitPot())).toBe('45000');
    // The collateral the position held is fully released and not released twice.
    expect(await balance(positionCollateralAccount(ALICE, 'USDT', positionId))).toBe('0');

    const [row] = await sql<{ status: string }[]>`SELECT status FROM trade.positions WHERE id = ${positionId}`;
    expect(row!.status).toBe('closed');
  }

  /**
   * How many times the ledger actually FUNDED a profit payout for this position.
   *
   * Distinct idempotency keys, not distinct posts: a repeated key is the same
   * transaction returned again and moves nothing, which is exactly the property
   * the stable close key buys.
   */
  function profitPayouts(positionId: string): number {
    const keys = new Set(
      posted.filter((p) => p.reason === 'futures.profit.realized' && p.meta?.positionId === positionId).map((p) => p.idempotencyKey),
    );
    return keys.size;
  }

  it('the honest baseline: one close pays 5000 once', async () => {
    const service = build(25);
    const pos = await openWinner(service);
    await service.close(ALICE, pos.id!);
    await expectPaidExactlyOnce(pos.id!);
    expect(profitPayouts(pos.id!)).toBe(1);
  });

  /**
   * THE REPRODUCTION. Eight closes fired at one position with a 25 ms mark read
   * between the row read and the row write.
   *
   * Against the unfixed service this paid 5000 eight times: Alice finished on
   * 140000 and the pot on 10000. Against a fixed one exactly one attempt closes
   * the position and the other seven are refused — and, crucially, the refusals
   * happen BEFORE anything posts, so the seven leave no trace in the ledger at
   * all.
   */
  it('eight concurrent closes with a 25 ms mark read pay the profit ONCE', async () => {
    const service = build(25);
    const pos = await openWinner(service);

    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => service.close(ALICE, pos.id!)));

    await expectPaidExactlyOnce(pos.id!);
    expect(profitPayouts(pos.id!)).toBe(1);

    // Exactly one attempt may claim the close. The rest must be told why, not
    // silently handed a 200 for work they did not do.
    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    for (const rejected of attempts.filter((a): a is PromiseRejectedResult => a.status === 'rejected')) {
      expect(rejected.reason).toMatchObject({ code: 'trade.position_not_open' });
    }
  });

  /**
   * The same assertion with an INSTANT mark.
   *
   * Kept because it is the test somebody would reasonably have written first,
   * and worth being precise about what it does and does not prove. Against the
   * unfixed service it DID reproduce here — two closes, 110000 — because
   * `checkProfitBound` awaits a balance read and that microtask boundary is
   * already a yield. What it did not do is reproduce at SCALE: eight attempts
   * through an instant mark interleave far less reliably than eight through a
   * 25 ms one, and a harness with no yield at all in the mark would have gone
   * green on broken code. The 25 ms variant above is the one carrying the proof.
   */
  it('two concurrent closes with an instant mark also pay once', async () => {
    const service = build(0);
    const pos = await openWinner(service);
    await Promise.allSettled([service.close(ALICE, pos.id!), service.close(ALICE, pos.id!)]);
    await expectPaidExactlyOnce(pos.id!);
    expect(profitPayouts(pos.id!)).toBe(1);
  });

  /**
   * WHAT THE ROW LOCK BUYS, STATED HONESTLY.
   *
   * Every balance assertion in this file also passes with `FOR UPDATE` removed,
   * because the stable idempotency key alone keeps the money right: the losing
   * attempts still post, the ledger recognises their posts as duplicates, and
   * nothing moves twice. Worth saying plainly rather than claiming a belt does
   * the braces' job.
   *
   * This is what the lock does do, and it is not cosmetic. Without it all eight
   * attempts read a stale `open`, walk the whole close — mark read, bound check,
   * every recipe — and post them into the ledger, and correctness rests entirely
   * on the ledger noticing. Leaning on downstream dedupe as the only line is how
   * this defect happened in the first place: `futuresMarginRelease` was deduped,
   * `futuresRealizeProfit` was not, and nobody noticed the difference until the
   * pot drained.
   *
   * With the lock, seven of eight refusals cost one blocked SELECT each and
   * never reach the ledger at all — which is also the file's stated contract
   * elsewhere: a close that is going to be refused leaves the books exactly as
   * it found them.
   */
  it('seven of eight concurrent closes are refused before they touch the ledger', async () => {
    const service = build(25);
    const pos = await openWinner(service);
    const before = posted.length;

    await Promise.allSettled(Array.from({ length: 8 }, () => service.close(ALICE, pos.id!)));

    // Exactly one close's worth of recipes: the profit payout and the margin
    // release. Not eight of each, deduped after the fact.
    const closePosts = posted.slice(before);
    expect(closePosts.filter((p) => p.reason === 'futures.profit.realized')).toHaveLength(1);
    expect(closePosts.filter((p) => p.reason === 'futures.margin.release')).toHaveLength(1);
    await expectPaidExactlyOnce(pos.id!);
  });

  it('sixteen concurrent closes are still one payout — the bound is not the control here', async () => {
    const service = build(25);
    const pos = await openWinner(service);
    await Promise.allSettled(Array.from({ length: 16 }, () => service.close(ALICE, pos.id!)));
    await expectPaidExactlyOnce(pos.id!);
    expect(profitPayouts(pos.id!)).toBe(1);
  });

  /**
   * THE SEQUENTIAL FORM OF THE SAME ROOT CAUSE.
   *
   * A lock only orders attempts that overlap. Put the row back to `open` — a
   * bad migration, an operator's UPDATE, a restore, a replayed event — and a
   * second close is not concurrent with anything, so no lock sees it. The only
   * thing that stops it paying again is that the idempotency key belongs to the
   * CLOSE and not to the ATTEMPT: the ledger recognises the second post as the
   * first one and returns it unchanged.
   *
   * That is why the fix is both halves. This test fails if either is reverted.
   */
  it('a row replayed to open does not pay the profit a second time', async () => {
    const service = build(0);
    const pos = await openWinner(service);
    await service.close(ALICE, pos.id!);
    await expectPaidExactlyOnce(pos.id!);

    await sql`UPDATE trade.positions SET status = 'open', closed_at = NULL WHERE id = ${pos.id}`;
    await Promise.allSettled([service.close(ALICE, pos.id!)]);

    // Not one satoshi more, whatever the second call answered.
    expect(await balance(userAvailable(ALICE, 'USDT'))).toBe('105000');
    expect(await balance(profitPot())).toBe('45000');
    expect(await balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).toBe('0');
    expect(profitPayouts(pos.id!)).toBe(1);
  });

  /**
   * The control that proves the previous tests are measuring something: two
   * DIFFERENT winning positions are two different closes and must pay twice.
   * A fix that keyed every futures profit to one constant would pass everything
   * above and steal from the trader instead of from the platform.
   */
  it('two different positions each get paid — the key is per position, not per service', async () => {
    const service = build(25);
    // A second futures market: `positions_open_unique_idx` allows one open
    // position per user per market, so two positions means two markets.
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET_2}, 'ETH/USDT-PERP', 'ETH', 'USDT', 'futures',
        '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'ETH perpetual', now()
      )
    `;
    feed('50000');
    feed('50000', MARKET_2);
    const a = await service.open({
      clientOpenId: 't-open-position-close-concurrency.test-2',
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    const b = await service.open({
      clientOpenId: 't-open-position-close-concurrency.test-3',
      userId: ALICE,
      symbol: 'ETH/USDT-PERP',
      side: 'long',
      size: amt('1'),
      leverage: amt('10'),
    });
    feed('55000');
    feed('55000', MARKET_2);
    await Promise.all([service.close(ALICE, a.id!), service.close(ALICE, b.id!)]);

    // 100000 − 10000 margin + 10000 back + 10000 profit.
    expect(await balance(userAvailable(ALICE, 'USDT'))).toBe('110000');
    expect(await balance(profitPot())).toBe('40000');
    expect(profitPayouts(a.id!)).toBe(1);
    expect(profitPayouts(b.id!)).toBe(1);
  });

  /**
   * Exit-when-dark (ADR 2026-08-07): a dark feed freezes rather than refuses.
   * Eight concurrent closes must still leave the books untouched and converge
   * on a single `closing` row — not eight errors and not a double freeze write
   * that breaks the reason check.
   */
  it('eight concurrent closes on a dark feed freeze once and nothing moves', async () => {
    const service = build(25);
    const pos = await openWinner(service);
    const beforeUser = await balance(userAvailable(ALICE, 'USDT'));
    marks.clear(MARKET);

    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => service.close(ALICE, pos.id!)));
    expect(attempts.every((a) => a.status === 'fulfilled')).toBe(true);
    for (const a of attempts) {
      if (a.status === 'fulfilled') {
        expect(a.value.status).toBe('closing');
        expect(a.value.closingReason).toBe('trade.mark_missing');
      }
    }

    expect(await balance(userAvailable(ALICE, 'USDT'))).toBe(beforeUser);
    expect(await balance(profitPot())).toBe('50000');
    expect(await balance(positionCollateralAccount(ALICE, 'USDT', pos.id!))).toBe('5000');
    const [row] = await sql<{ status: string; closing_reason: string | null }[]>`
      SELECT status, closing_reason FROM trade.positions WHERE id = ${pos.id}
    `;
    expect(row!.status).toBe('closing');
    expect(row!.closing_reason).toBe('trade.mark_missing');
  });
});
