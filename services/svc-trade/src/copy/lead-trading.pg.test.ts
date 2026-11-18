/**
 * The lead limits against real Postgres (J-copy-bots-otc-04 #7; the CI review's finding on #8821): the holding and the
 * daily buy cap count only lead orders that exist in `trade.orders`, a live buy whole, a finished buy as filled, and a
 * sell only as filled. A row whose place was refused, a cancelled buy and a sell that never ran count for nothing.
 * TEST figures only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { principalFor } from '../spot/testing.js';
import { CopyError } from './errors.js';
import { LeadTrading, type LeadOrderAsk } from './lead-trading.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const MARKET = '22222222-2222-4222-8222-222222222222';
const LEAD = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-18T10:00:00.000Z');
const lead = principalFor(LEAD, ['trade:read', 'trade:write']);

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_lead_trading_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const ask = (over: Partial<LeadOrderAsk> = {}): LeadOrderAsk => ({
  orderId: '99999999-9999-4999-8999-999999999999',
  symbol: 'USDC/USDT',
  side: 'buy',
  price: parseAmount('1'),
  amount: parseAmount('100'),
  iceberg: false,
  lead: true,
  ...over,
});

describe('the lead limits count only lead orders that exist, by what they commit (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let n = 0;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.copy_lead_orders, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    await db.sql`
      INSERT INTO trade.markets (id, symbol, display_name, base_asset, quote_asset, tick_size, lot_size, min_qty, max_qty, min_notional, maker_bps, taker_bps)
      VALUES (${MARKET}, 'USDC/USDT', 'TEST USDC/USDT', 'USDC', 'USDT', '0.0001', '0.01', '0.01', '1000000', '1', 10, 20)`;
  });

  /** A lead order row, and its order when `status` is given (none: the place was refused or never ran). */
  async function leadOrder(side: 'buy' | 'sell', qty: string, status?: string, filled = '0') {
    n += 1;
    const id = `55555555-5555-4555-8555-${n.toString(16).padStart(12, '0')}`;
    if (status) {
      await db.sql`
        INSERT INTO trade.orders (id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif, hold_asset, hold_amount)
        VALUES (${id}, ${LEAD}, ${MARKET}, ${`lead-${n}`}, ${side}, 'limit', '1', ${qty}, ${filled}, ${status}, 'GTC',
                ${side === 'buy' ? 'USDT' : 'USDC'}, ${qty})`;
    }
    await db.sql`
      INSERT INTO trade.copy_lead_orders (order_id, leader_user_id, symbol, side, notional, lead, not_lead_reason, created_at)
      VALUES (${id}, ${LEAD}, 'USDC/USDT', ${side}, ${qty}, true, NULL, ${NOW.toISOString()})`;
  }

  function trading(limits: { dailyBuyCap: string; holding: string }) {
    return new LeadTrading({
      sql: db.sql,
      now: () => NOW,
      listing: async () => ({ state: 'listed', assets: ['USDC/USDT'] }),
      minVenueUsdc: parseAmount('1000'),
      venueUsdc: async () => ({ state: 'read', owner: '0xabc', test: true, usdc: parseAmount('3000'), asOf: NOW }),
      limits: { dailyBuyCap: parseAmount(limits.dailyBuyCap), pairHolding: new Map([['USDC/USDT', parseAmount(limits.holding)]]) },
      ownerDay: { published: true, offsetMinutes: 0 },
    });
  }

  async function codeOf(p: Promise<unknown>): Promise<string | null> {
    try {
      await p;
      return null;
    } catch (err) {
      if (err instanceof CopyError) return err.code;
      throw err;
    }
  }

  it('a row whose place never ran and a cancelled buy count for nothing; a live buy counts whole', async () => {
    const t = trading({ dailyBuyCap: '100000', holding: '5000' });
    await leadOrder('buy', '4950');
    await leadOrder('buy', '4950', 'cancelled');
    expect(await codeOf(t.decide(lead, ask()))).toBeNull();
    await leadOrder('buy', '4950', 'open');
    expect(await codeOf(t.decide(lead, ask()))).toBe('trade.copy_pair_holding_limit');
  });

  it('a filled buy counts as filled; a sell counts only as filled, so a sell that never ran frees no room', async () => {
    const t = trading({ dailyBuyCap: '100000', holding: '5000' });
    await leadOrder('buy', '6000', 'cancelled', '4950');
    await leadOrder('sell', '4950', 'cancelled');
    expect(await codeOf(t.decide(lead, ask()))).toBe('trade.copy_pair_holding_limit');
    await leadOrder('sell', '200', 'filled', '200');
    expect(await codeOf(t.decide(lead, ask()))).toBeNull();
  });

  it('the daily buy cap counts today’s live buys whole and finished ones as filled, never a refused place', async () => {
    const t = trading({ dailyBuyCap: '500', holding: '100000' });
    await leadOrder('buy', '450');
    await leadOrder('buy', '450', 'cancelled');
    expect(await codeOf(t.decide(lead, ask()))).toBeNull();
    await leadOrder('buy', '450', 'open');
    expect(await codeOf(t.decide(lead, ask()))).toBe('trade.copy_daily_buy_cap');
  });
});
