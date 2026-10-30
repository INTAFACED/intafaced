/**
 * Local TEST spot listings. Not production config, and not a launch listing.
 *
 * `local-test-gates.mjs apply` lists these on the local stack so the journeys that price one coin in another
 * (J-portfolio-02 step 7) have a market with no dollar side, and a book the market maker leaves alone
 * (`UNQUOTED_TEST_SPOT`). Each row is `test = true` (shown on GET /api/v1/markets only with TRADE_FUTURES_TEST_SEED, which the stack sets) and its display name says TEST. The fees are the seeded
 * crypto pairs' (svc-trade drizzle/0001); the tick and minimums are sized for a price in BTC (about 0.04), and it is
 * listed on the default plane only. The database name must look local or test, and NODE_ENV production refuses.
 */
import { SeedRefusal, databaseLooksLocalOrTest, databaseNameFromUrl } from './seed-futures-test-listing.mjs';

export const TEST_SPOT_LISTINGS = Object.freeze([
  Object.freeze({
    symbol: 'ETH/BTC',
    baseAsset: 'ETH',
    quoteAsset: 'BTC',
    displayName: 'Ether in Bitcoin (TEST)',
    tickSize: '0.00001',
    lotSize: '0.0001',
    minQty: '0.0001',
    minNotional: '0.0001',
    makerBps: '10',
    takerBps: '20',
  }),
  Object.freeze({
    symbol: 'IFC/USDC',
    baseAsset: 'IFC',
    quoteAsset: 'USDC',
    displayName: 'IFC in USD Coin (TEST, unquoted)',
    tickSize: '0.0001',
    lotSize: '0.01',
    minQty: '0.01',
    minNotional: '0.01',
    makerBps: '10',
    takerBps: '20',
  }),
]);

/** TEST listings the market maker never quotes, so their book holds only what a journey rests on it (J-copy-bots-otc-23
 * step 7 needs a book with one side empty and a known size on the other). Every other listing is quoted. */
export const UNQUOTED_TEST_SPOT = Object.freeze(['IFC/USDC']);

/** The url back, or a refusal when its database is not obviously local or test. */
export function localTestDatabaseUrl(url, env = process.env) {
  if (env.NODE_ENV === 'production') throw new SeedRefusal('refusing: NODE_ENV is production. This seed is local-only.');
  const name = databaseNameFromUrl(url);
  if (!databaseLooksLocalOrTest(name)) throw new SeedRefusal(`refusing: database "${name}" does not look local or test`);
  return url;
}

export async function insertSpotTestListing(sql, l) {
  // `markets_test_fixture_ck`: a TEST row keeps the explicit values it was seeded with. A re-seed writes the grid and
  // fees again with the fixture, so the row and its fixture never disagree.
  const fixture = { kind: 'spot', label: 'LOCAL TEST', ...l };
  const rows = await sql`
    INSERT INTO trade.markets (
      symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
      maker_bps, taker_bps, status, display_name, listed_at, "test", test_fixture
    ) VALUES (
      ${l.symbol}, ${l.baseAsset}, ${l.quoteAsset}, 'spot', ${l.tickSize}::numeric, ${l.lotSize}::numeric,
      ${l.minQty}::numeric, ${l.minNotional}::numeric, ${l.makerBps}::numeric, ${l.takerBps}::numeric,
      'active', ${l.displayName}, now(), true, ${sql.json(fixture)}
    )
    ON CONFLICT (symbol) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      tick_size = EXCLUDED.tick_size,
      lot_size = EXCLUDED.lot_size,
      min_qty = EXCLUDED.min_qty,
      min_notional = EXCLUDED.min_notional,
      maker_bps = EXCLUDED.maker_bps,
      taker_bps = EXCLUDED.taker_bps,
      test_fixture = EXCLUDED.test_fixture,
      updated_at = now()
    WHERE trade.markets."test" = true
    RETURNING id, symbol
  `;
  if (!rows[0]) throw new SeedRefusal(`refusing: ${l.symbol} already exists and is not a TEST listing. It was not overwritten.`);
  return rows[0];
}
