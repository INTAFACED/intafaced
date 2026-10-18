#!/usr/bin/env node
/**
 * Local TEST futures listing. Not production config.
 *
 *   TRADE_DATABASE_URL=postgres://…/intafaced_test \
 *     node tooling/scripts/seed-futures-test-listing.mjs \
 *     --fixture services/svc-trade/fixtures/btc-usdt-swap.TEST.json
 *
 * The fixture (or every flag, when there is no fixture) must name the symbol,
 * a display name containing TEST, leverageCap, mark feed, liquidation policy,
 * and the grid and fees. Missing any of those exits non-zero. Nothing here
 * fills a blank with a default.
 *
 * The database name must look local or test (`*_test`, `test`, `local`, or a
 * name containing "local"). `intafaced` and any other name are refused.
 * TRADE_FUTURES_ENABLED is not set. The row is `test = true`. It stays off
 * GET /api/v1/markets until TRADE_FUTURES_TEST_SEED is on.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED = [
  'symbol',
  'displayName',
  'baseAsset',
  'quoteAsset',
  'leverageCap',
  'markFeed',
  'liquidationPolicy',
  'tickSize',
  'lotSize',
  'minQty',
  'minNotional',
  'makerBps',
  'takerBps',
];

const DECIMAL_KEYS = ['leverageCap', 'tickSize', 'lotSize', 'minQty', 'minNotional'];

export class SeedRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeedRefusal';
  }
}

export function databaseNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] ?? '');
  } catch {
    return '';
  }
}

/** True only for a name that is obviously a local or test database. */
export function databaseLooksLocalOrTest(name) {
  const n = String(name ?? '')
    .trim()
    .toLowerCase();
  if (n === '') return false;
  if (n.endsWith('_test')) return true;
  if (n === 'test' || n === 'local') return true;
  if (n.includes('local')) return true;
  return false;
}

function positiveDecimal(value, key) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s) || /^0+(?:\.0+)?$/.test(s)) {
    throw new SeedRefusal(`${key} must be an explicit positive decimal; refusing to invent one`);
  }
  return s;
}

function bps(value, key) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) throw new SeedRefusal(`${key} must be an explicit integer basis-point string`);
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n >= 10000) {
    throw new SeedRefusal(`${key} must be an integer from 0 to 9999`);
  }
  return s;
}

function requiredText(value, key) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s === '') throw new SeedRefusal(`${key} is required; refusing to invent it`);
  return s;
}

/**
 * @param {{ env: Record<string, string | undefined>, fixturePath?: string | null, fixtureText?: string | null, cli?: Record<string, string | undefined> }} input
 */
export function evaluateSeedRequest(input) {
  if (input.env.NODE_ENV === 'production') {
    throw new SeedRefusal('refusing: NODE_ENV is production. This seed is local-only.');
  }
  const databaseUrl = input.env.TRADE_DATABASE_URL?.trim() || input.env.DATABASE_URL?.trim() || '';
  if (databaseUrl === '') {
    throw new SeedRefusal('refusing: TRADE_DATABASE_URL or DATABASE_URL is required. There is no default database.');
  }
  const databaseName = databaseNameFromUrl(databaseUrl);
  if (!databaseLooksLocalOrTest(databaseName)) {
    throw new SeedRefusal(`refusing: database "${databaseName || '(unparsed)'}" does not look like a local or test database`);
  }

  let raw;
  if (input.fixturePath) {
    if (!input.fixturePath.includes('TEST')) {
      throw new SeedRefusal('refusing: the fixture path must be marked TEST');
    }
    if (input.fixtureText == null) throw new SeedRefusal('refusing: the fixture file could not be read');
    try {
      raw = JSON.parse(input.fixtureText);
    } catch {
      throw new SeedRefusal('refusing: the fixture is not JSON');
    }
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SeedRefusal('refusing: the fixture must be a JSON object');
    }
    if (raw.marked !== 'TEST') throw new SeedRefusal('refusing: the fixture must be marked "TEST"');
  } else {
    raw = input.cli ?? {};
    if (Object.keys(raw).length === 0) {
      throw new SeedRefusal('refusing: pass --fixture <file.TEST.json> or every explicit flag. Nothing is assumed.');
    }
  }

  for (const key of REQUIRED) {
    if (raw[key] == null || (typeof raw[key] === 'string' && raw[key].trim() === '')) {
      throw new SeedRefusal(`refusing: ${key} is missing. The seed does not invent it.`);
    }
  }

  const displayName = requiredText(raw.displayName, 'displayName');
  if (!displayName.includes('TEST')) {
    throw new SeedRefusal('refusing: displayName must contain TEST');
  }
  const baseAsset = requiredText(raw.baseAsset, 'baseAsset');
  const quoteAsset = requiredText(raw.quoteAsset, 'quoteAsset');
  if (baseAsset === quoteAsset) throw new SeedRefusal('refusing: baseAsset and quoteAsset must differ');

  const markFeed = requiredText(raw.markFeed, 'markFeed');
  const policy = raw.liquidationPolicy;
  if (typeof policy === 'number' || policy == null) {
    throw new SeedRefusal('refusing: liquidationPolicy must be an explicit string or object, not a number');
  }
  if (typeof policy === 'string' && policy.trim() === '') {
    throw new SeedRefusal('refusing: liquidationPolicy is empty');
  }
  if (typeof policy !== 'string' && (typeof policy !== 'object' || Array.isArray(policy))) {
    throw new SeedRefusal('refusing: liquidationPolicy must be an explicit string or object');
  }

  return {
    databaseUrl,
    databaseName,
    listing: {
      symbol: requiredText(raw.symbol, 'symbol'),
      displayName,
      baseAsset,
      quoteAsset,
      leverageCap: positiveDecimal(raw.leverageCap, 'leverageCap'),
      markFeed,
      liquidationPolicy: typeof policy === 'string' ? policy.trim() : policy,
      tickSize: positiveDecimal(raw.tickSize, 'tickSize'),
      lotSize: positiveDecimal(raw.lotSize, 'lotSize'),
      minQty: positiveDecimal(raw.minQty, 'minQty'),
      minNotional: positiveDecimal(raw.minNotional, 'minNotional'),
      makerBps: bps(raw.makerBps, 'makerBps'),
      takerBps: bps(raw.takerBps, 'takerBps'),
    },
  };
}

export async function insertFuturesTestListing(sql, listing) {
  const fixture = {
    leverageCap: listing.leverageCap,
    markFeed: listing.markFeed,
    liquidationPolicy: listing.liquidationPolicy,
  };
  const rows = await sql`
    INSERT INTO trade.markets (
      symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
      maker_bps, taker_bps, status, display_name, listed_at, futures_contract_style,
      "test", test_fixture
    ) VALUES (
      ${listing.symbol}, ${listing.baseAsset}, ${listing.quoteAsset}, 'futures',
      ${listing.tickSize}::numeric, ${listing.lotSize}::numeric, ${listing.minQty}::numeric,
      ${listing.minNotional}::numeric, ${listing.makerBps}::numeric, ${listing.takerBps}::numeric,
      'active', ${listing.displayName}, now(), 'perpetual',
      true, ${sql.json(fixture)}
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
    RETURNING id, symbol, display_name
  `;
  const row = rows[0];
  if (!row) {
    throw new SeedRefusal(`refusing: ${listing.symbol} already exists and is not a TEST listing. It was not overwritten.`);
  }
  return row;
}

function cliValues(argv) {
  const map = {
    symbol: 'symbol',
    'display-name': 'displayName',
    'leverage-cap': 'leverageCap',
    'mark-feed': 'markFeed',
    'liquidation-policy': 'liquidationPolicy',
    'tick-size': 'tickSize',
    'lot-size': 'lotSize',
    'min-qty': 'minQty',
    'min-notional': 'minNotional',
    'maker-bps': 'makerBps',
    'taker-bps': 'takerBps',
    base: 'baseAsset',
    quote: 'quoteAsset',
  };
  const cli = {};
  let fixture = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixture') {
      fixture = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = map[arg.slice(2)];
      if (!key) throw new SeedRefusal(`refusing: unknown flag ${arg}`);
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) throw new SeedRefusal(`refusing: ${arg} has no value`);
      cli[key] = value;
      i += 1;
    }
  }
  return { fixture, cli };
}

async function main() {
  const { fixture, cli } = cliValues(process.argv.slice(2));
  let fixtureText = null;
  if (fixture) fixtureText = readFileSync(fixture, 'utf8');
  const decision = evaluateSeedRequest({
    env: process.env,
    fixturePath: fixture,
    fixtureText,
    cli,
  });
  const postgres = (await import('postgres')).default;
  const sql = postgres(decision.databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const row = await insertFuturesTestListing(sql, decision.listing);
    process.stdout.write(`listed TEST ${row.symbol} (${row.id})\n`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
