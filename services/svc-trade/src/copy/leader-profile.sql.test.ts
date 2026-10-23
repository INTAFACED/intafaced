/**
 * CB-copy-01 / CB-copy-02 on Postgres (TEST_DATABASE_URL; does not start Docker): the directory's mode and name
 * filters run in SQL, and a lead's trade table is read from that leader's own spot fills only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { CopyService } from '../controls/test-admission.js';
import { principalFor } from '../spot/testing.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { SqlCopyFollowStore } from './follow-store.js';
import { sqlLeaderDirectory } from './leader-directory.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const OP = '00000000-0000-4000-8000-0000000000aa';
const READER = '00000000-0000-4000-8000-0000000000b1';
const LEADER = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const MARKET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PAPER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const COUNTER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

const operator = () => principalFor(OP, ['admin:write']);
const reader = () => principalFor(READER, ['trade:read']);

function openDb(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
  return url;
}

describe('copy leader directory filters and lead trades on Postgres', () => {
  let db: TestDatabase | undefined;
  let seq = 0;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: openDb(), migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await truncateTradeExceptOrderEvents(db!.sql);
  });

  function harness() {
    let tick = Date.parse('2026-10-23T00:00:00.000Z');
    const now = () => new Date((tick += 60_000));
    return new CopyService(new MemoryLedger(), {
      store: new SqlCopyFollowStore(db!.sql),
      directory: sqlLeaderDirectory(db!.sql, { now, feeShareLaw: { published: false } }),
      sql: db!.sql,
      now,
    });
  }

  async function list(copy: CopyService, leaderUserId: string, displayName: string, marketMode?: 'spot' | 'futures') {
    return copy.upsertListing(operator(), {
      clientRequestId: `list:${leaderUserId}`,
      leaderUserId,
      displayName,
      recordKind: 'self_reported',
      state: 'listed',
      ...(marketMode ? { marketMode } : {}),
    });
  }

  async function fill(userId: string, marketId: string, side: 'buy' | 'sell', price: string, qty: string, ts: string) {
    seq += 1;
    const orderId = `cccccccc-cccc-4ccc-8ccc-${String(seq).padStart(12, '0')}`;
    const quote = (Number(price) * Number(qty)).toString(); // TEST fixture figures, whole numbers only
    await db!.sql`
      INSERT INTO trade.orders (id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif, hold_asset, hold_amount)
      VALUES (${orderId}, ${userId}, ${marketId}, ${orderId}, ${side}, 'limit', ${price}, ${qty}, ${qty}, 'filled', 'GTC', 'USDT', ${quote})
    `;
    await db!.sql`
      INSERT INTO trade.fills (id, order_id, counter_order_id, market_id, user_id, side, liquidity, price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence, ts)
      VALUES (${orderId}, ${orderId}, ${COUNTER}, ${marketId}, ${userId}, ${side}, 'taker', ${price}, ${qty}, ${quote}, 'USDT', '0', 0, ${seq}, ${ts})
    `;
    return orderId;
  }

  it('filters by mode and by name in SQL, and a % in the search is matched literally', async () => {
    const copy = harness();
    await list(copy, LEADER, 'Abby 100% Spot');
    await list(copy, OTHER, 'Cabin Futures', 'futures');
    await list(copy, '00000000-0000-4000-8000-0000000000c3', 'Zed', 'futures');

    const futures = await copy.listLeaders(reader(), { limit: 10, marketMode: 'futures' });
    expect(futures.leaders.map((l) => l.displayName)).toEqual(['Cabin Futures', 'Zed']);
    expect((await copy.listLeaders(reader(), { limit: 10, q: 'aB' })).leaders.map((l) => l.displayName)).toEqual([
      'Abby 100% Spot',
      'Cabin Futures',
    ]);
    expect((await copy.listLeaders(reader(), { limit: 10, q: '100%' })).leaders.map((l) => l.displayName)).toEqual(['Abby 100% Spot']);
    expect((await copy.listLeaders(reader(), { limit: 10, q: '%' })).leaders.map((l) => l.displayName)).toEqual(['Abby 100% Spot']);
    expect((await copy.listLeaders(reader(), { limit: 10, q: '_' })).leaders).toEqual([]);
  });

  it('a row written before the mode column reads as a spot leader', async () => {
    const copy = harness();
    await list(copy, LEADER, 'Old Row');
    await db!.sql`UPDATE trade.copy_leader_listings SET market_mode = DEFAULT`;
    const page = await copy.listLeaders(reader(), { limit: 10, marketMode: 'spot' });
    expect(page.leaders.map((l) => l.displayName)).toEqual(['Old Row']);
  });

  it("reads the lead's own live spot fills, pairs them, and leaves out other users and paper books", async () => {
    await db!.sql`
      INSERT INTO trade.markets (id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional, maker_bps, taker_bps, status, display_name, paper)
      VALUES
        (${MARKET}, 'BTC/USDT', 'BTC', 'USDT', 'spot', 0.01, 0.0001, 0.0001, 1, 10, 20, 'pending', 'BTC/USDT', false),
        (${PAPER}, 'PBTC/USDT', 'PBTC', 'USDT', 'spot', 0.01, 0.0001, 0.0001, 1, 10, 20, 'pending', 'PBTC/USDT', true)
    `;
    const copy = harness();
    const listed = await list(copy, LEADER, 'Lead');
    const entry = await fill(LEADER, MARKET, 'buy', '100', '2', '2026-10-23T01:00:00Z');
    await fill(LEADER, MARKET, 'sell', '120', '2', '2026-10-23T02:00:00Z');
    await fill(LEADER, MARKET, 'buy', '130', '1', '2026-10-23T03:00:00Z');
    await fill(OTHER, MARKET, 'buy', '1', '1', '2026-10-23T04:00:00Z');
    await fill(LEADER, PAPER, 'buy', '1', '1', '2026-10-23T05:00:00Z');
    await db!.sql`INSERT INTO trade.order_bracket_intent (order_id, user_id, take_profit, stop_loss) VALUES (${entry}, ${LEADER}, 150, 90)`;

    const first = await copy.leaderTrades(reader(), { leaderRef: listed.leaderRef, limit: 1 });
    expect(first.trades).toEqual([
      expect.objectContaining({ symbol: 'BTC/USDT', state: 'open', entryPrice: '130', margin: '130', closePrice: null, roiPercent: null }),
    ]);
    expect(first.nextCursor).toMatch(/^\d+\.[0-9a-f]{24}$/);
    const second = await copy.leaderTrades(reader(), { leaderRef: listed.leaderRef, limit: 1, cursor: first.nextCursor! });
    expect(second.trades).toEqual([
      expect.objectContaining({
        state: 'closed',
        entryPrice: '100',
        qty: '2',
        margin: '200',
        takeProfit: '150',
        stopLoss: '90',
        closePrice: '120',
        roiPercent: '20',
      }),
    ]);
    expect(second.nextCursor).toBeNull();
    // Nothing that identifies an order, a fill or a user leaves the read.
    expect(JSON.stringify([first, second])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
