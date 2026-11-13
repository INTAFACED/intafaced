/**
 * The lead's own stop check reads what a leader holds (J-copy-bots-otc-05 #7, CB-copy-18), against Postgres.
 *
 * Promise: a buy whose fee was taken in the base asset leaves the leader holding its quantity less that fee; selling
 * exactly that closes the position, so a lead can stop leading. A remainder smaller than the market's smallest sellable
 * quantity can never be sold, so it is no open position; one lot or more still is. The public trade history still shows
 * the gross buy.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { pairLeaderTrades, readLeaderOrderFills, readSpotSellableFloors, sellableOpen } from './leader-profile.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  if (decodeURIComponent(parsed.pathname.replace(/^\//, '')).endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

describe('a leader’s held spot position', () => {
  let db: TestDatabase;
  let spot = '';

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
    const [market] = await db.sql<Array<{ id: string; base_asset: string }>>`
      SELECT id, base_asset FROM trade.markets WHERE symbol = 'BTC/USDT' AND kind = 'spot' AND paper = false`;
    spot = market!.id;
    expect(market!.base_asset).toBe('BTC');
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  /** One filled order of `who`, with one fill whose fee is `fee` in `feeAsset`. */
  async function filled(who: string, side: 'buy' | 'sell', qty: string, quote: string, feeAsset: string, fee: string, seq: number) {
    const id = randomUUID();
    await db.sql`
      INSERT INTO trade.orders (id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif, hold_asset, hold_amount)
      VALUES (${id}, ${who}, ${spot}, ${`c-${id}`}, ${side}, 'limit', '50000', ${qty}, ${qty}, 'filled', 'GTC',
        ${side === 'buy' ? 'USDT' : 'BTC'}, ${side === 'buy' ? quote : qty})`;
    await db.sql`INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity, price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence, ts
      ) VALUES (${randomUUID()}, ${id}, ${randomUUID()}, ${spot}, ${who}, ${side}, 'taker', 50000, ${qty}, ${quote}, ${feeAsset}, ${fee}, 10, ${seq},
        ${new Date(Date.UTC(2026, 10, 13, 0, 0, seq))})`;
  }

  it('closes once the leader sells all a BTC-fee buy left them; the gross read still shows it open', async () => {
    const lead = randomUUID();
    await filled(lead, 'buy', '0.001', '50', 'BTC', '0.000001', 1);
    await filled(lead, 'sell', '0.000999', '49.95', 'USDT', '0.04995', 2);

    const held = pairLeaderTrades(await readLeaderOrderFills(db.sql, lead, { held: true }));
    expect(held.filter((t) => t.state === 'open')).toEqual([]);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ state: 'closed', qty: '0.000999', closedQty: '0.000999' });

    const gross = pairLeaderTrades(await readLeaderOrderFills(db.sql, lead));
    expect(gross[0]).toMatchObject({ state: 'open', qty: '0.001', closedQty: '0.000999' });
  });

  it('stays open while any of what the leader holds is unsold, and a quote-asset fee takes nothing off the buy', async () => {
    const lead = randomUUID();
    await filled(lead, 'buy', '0.002', '100', 'USDT', '0.1', 3);
    await filled(lead, 'sell', '0.001', '50', 'USDT', '0.05', 4);

    const held = pairLeaderTrades(await readLeaderOrderFills(db.sql, lead, { held: true }));
    expect(held.map((t) => ({ state: t.state, qty: t.qty, closedQty: t.closedQty }))).toEqual([
      { state: 'open', qty: '0.002', closedQty: '0.001' },
    ]);
  });
  it('leaves out a remainder under one lot, which can never be sold, and keeps a whole lot open', async () => {
    const [market] = await db.sql<Array<{ lot_size: string; min_qty: string }>>`
      SELECT lot_size::text AS lot_size, min_qty::text AS min_qty FROM trade.markets WHERE id = ${spot}`;
    const floors = await readSpotSellableFloors(db.sql);
    const lot = parseAmount(market!.lot_size);
    const min = parseAmount(market!.min_qty);
    expect(floors.get('BTC/USDT')).toBe(lot > min ? lot : min);

    // The lead sold every whole lot a BTC-fee buy left them: under one lot is left.
    const dust = randomUUID();
    await filled(dust, 'buy', '0.001', '50', 'BTC', '0.000001', 5);
    await filled(dust, 'sell', '0.00099', '49.5', 'USDT', '0.0495', 6);
    const dustTrades = pairLeaderTrades(await readLeaderOrderFills(db.sql, dust, { held: true }));
    expect(dustTrades.filter((t) => t.state === 'open')).toHaveLength(1);
    expect(sellableOpen(dustTrades, floors)).toEqual([]);

    // A whole sellable floor left unsold is a position the lead can close, so it stays open.
    const whole = randomUUID();
    const floor = floors.get('BTC/USDT')!;
    await filled(whole, 'buy', formatAmount(floor * 3n), '50', 'USDT', '0.05', 7);
    await filled(whole, 'sell', formatAmount(floor * 2n), '30', 'USDT', '0.03', 8);
    expect(sellableOpen(pairLeaderTrades(await readLeaderOrderFills(db.sql, whole, { held: true })), floors)).toHaveLength(1);

    // A market with no published floor keeps its row open: fail closed.
    expect(sellableOpen(dustTrades, new Map())).toHaveLength(1);
  });
});
