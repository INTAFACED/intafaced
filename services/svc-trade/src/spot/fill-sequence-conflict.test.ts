import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fillLegIdFor } from './ids.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';

import { TradeError, type Market } from './types.js';

/**
 * ONE SEQUENCE, ONE MATCH — AND WHAT HAPPENS WHEN THAT STOPS BEING TRUE.
 *
 * `trade.fills` carries two unique keys: `fills_pkey` on `id`, and
 * `fills_market_sequence_role_idx` on `(market_id, sequence, liquidity)`. The
 * insert arbitrated on `id` alone, and Postgres applies `ON CONFLICT` to the
 * named arbiter and to nothing else — so a row that cleared the primary key and
 * then collided on the sequence index raised a bare 23505. It reached the
 * caller as a 500 carrying a Postgres string, and CI as an intermittent CX-8
 * failure that a re-run made disappear (observed on PR #895).
 *
 * The tempting fix is a wider `ON CONFLICT DO NOTHING`. These tests exist
 * because that fix is wrong, and they are written to fail if anyone applies it:
 * the two ways to reach this collision need OPPOSITE handling.
 *
 *   · REDELIVERY — the same match settled twice. `fillLegIdFor` derives from
 *     `(market, sequence, role)`, so the second attempt computes the same row.
 *     Absorb it; the ledger post is idempotent on `trade.fill:<fillId>`.
 *
 *   · SEQUENCE REUSE — a DIFFERENT match claims a sequence already spoken for.
 *     `OrderBook.sequence` is an in-memory counter starting at 0, rebuilt by
 *     journal replay, so a book restored without its journal hands an old
 *     sequence to a new trade. Absorbing THAT aliases two trades onto one
 *     ledger idempotency key: the first settles, the second silently never
 *     does, and its fill row claims it did.
 *
 * A 500 is bad. Silently losing the second trade's money movement is worse.
 */

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
      `H8a: svc-trade fill-sequence-conflict is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade fill-sequence-conflict (H8a PG-hard)', () => {
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
  let bus: MemoryEventBus;
  let matching: StubMatching;
  let perks: StubPerks;
  let trade: TradeService;
  let btcusdt: Market;

  async function fund(userId: string, assetId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId,
        amount: amt(amount),
        rail: 'test',
        railRef: `${userId}:${assetId}:${amount}:${Math.random()}`,
      }),
    );
  }

  beforeEach(async () => {
    await sql`TRUNCATE trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-trade');
    matching = new StubMatching();
    perks = new StubPerks();
    trade = new TradeService(sql, ledger, matching, perks, bus, {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    btcusdt = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
  });

  /**
   * Two resting orders and no match — `settleFillEvent` is then driven directly
   * so the sequence under test is chosen rather than guessed. Going through
   * `placeOrder` would let StubMatching pick the sequence, and a test that has
   * to discover which number it got cannot plant a collision on it first.
   */
  async function restingPair(): Promise<{ makerId: string; takerId: string }> {
    await fund(BOB, 'BTC', '10');
    await fund(ALICE, 'USDT', '10000');
    const maker = await trade.placeOrder(principalFor(BOB), {
      marketId: btcusdt.id,
      side: 'sell',
      type: 'limit',
      price: amt('100'),
      qty: amt('1'),
      clientOrderId: `maker-${Math.random()}`,
    });
    const taker = await trade.placeOrder(principalFor(ALICE), {
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      price: amt('100'),
      qty: amt('1'),
      clientOrderId: `taker-${Math.random()}`,
    });
    return { makerId: maker.id, takerId: taker.id };
  }

  const SEQ = 7;

  it('a sequence already owned by a DIFFERENT match is refused by name, not by Postgres', async () => {
    const { makerId, takerId } = await restingPair();

    /**
     * Plant the collision the way a restored-without-journal book would: a row
     * holding this `(market, sequence, role)` under a DIFFERENT id.
     * `fillLegIdFor` is bijective with the triple, so occupying it under
     * another id is the only shape this failure can take.
     */
    const foreignFillId = '99999999-9999-8999-8999-999999999999';
    expect(foreignFillId).not.toBe(fillLegIdFor(btcusdt.id, SEQ, 'maker'));

    await sql`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      ) VALUES (
        ${foreignFillId}, ${makerId}, ${takerId}, ${btcusdt.id}, ${BOB}, 'sell', 'maker',
        ${'100'}::numeric, ${'1'}::numeric, ${'100'}::numeric, 'USDT', ${'0'}::numeric, 0, ${SEQ}
      )
    `;

    const before = ledger.journal().length;

    await expect(
      trade.settleFillEvent({
        marketId: btcusdt.id,
        makerOrderId: makerId,
        takerOrderId: takerId,
        price: '100',
        qty: '1',
        sequence: SEQ,
      }),
    ).rejects.toSatisfy(
      // Named, not a raw PostgresError. The distinction IS the fix: a bare
      // 23505 string tells an operator nothing about which trade was lost.
      (err: unknown) => err instanceof TradeError && err.code === 'trade.fill_sequence_conflict',
      'expected a named trade.fill_sequence_conflict, not a raw Postgres 23505',
    );

    // And nothing moved. A refusal that had already posted half a fill would be
    // the worst of both worlds.
    expect(ledger.journal().length).toBe(before);
  });

  it('the SAME match settling twice is absorbed silently and moves money once', async () => {
    const { makerId, takerId } = await restingPair();

    const settle = () =>
      trade.settleFillEvent({
        marketId: btcusdt.id,
        makerOrderId: makerId,
        takerOrderId: takerId,
        price: '100',
        qty: '1',
        sequence: SEQ,
      });

    await settle();

    const [firstRows] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.fills`;
    const firstPosts = ledger.journal().filter((tx) => tx.reason === 'trade.fill').length;
    expect(Number(firstRows?.n)).toBe(2); // one maker leg, one taker leg
    expect(firstPosts).toBe(1);

    // The JetStream redelivery: identical event, second delivery.
    await expect(settle()).resolves.toBeUndefined();

    const [secondRows] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.fills`;
    const secondPosts = ledger.journal().filter((tx) => tx.reason === 'trade.fill').length;

    // No new rows and no second movement: the row is keyed on the match, and
    // the ledger key `trade.fill:<fillId>` returns the original transaction.
    expect(secondRows?.n).toBe(firstRows?.n);
    expect(secondPosts).toBe(firstPosts);
  });
});
