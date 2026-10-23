/**
 * Local TEST spot listings. Not production config, and not a launch listing.
 *
 * `local-test-gates.mjs apply` lists these on the local stack so the journeys that price one coin in another
 * (J-portfolio-02 step 7) have a market with no dollar side. Each row is `test = true` (shown on GET /api/v1/markets
 * only with TRADE_FUTURES_TEST_SEED, which the stack sets) and its display name says TEST. The grid and fees are the
 * ones the seeded crypto pairs use (svc-trade drizzle/0001). The database name must look local or test.
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
]);

/** The url back, or a refusal when its database is not obviously local or test. */
export function localTestDatabaseUrl(url) {
  const name = databaseNameFromUrl(url);
  if (!databaseLooksLocalOrTest(name)) throw new SeedRefusal(`refusing: database "${name}" does not look local or test`);
  return url;
}

export async function insertSpotTestListing(sql, l) {
  // `markets_test_fixture_ck`: a TEST row keeps the explicit values it was seeded with.
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
    ON CONFLICT (symbol) DO UPDATE SET display_name = EXCLUDED.display_name, test_fixture = EXCLUDED.test_fixture, updated_at = now()
    WHERE trade.markets."test" = true
    RETURNING id, symbol
  `;
  if (!rows[0]) throw new SeedRefusal(`refusing: ${l.symbol} already exists and is not a TEST listing. It was not overwritten.`);
  return rows[0];
}
