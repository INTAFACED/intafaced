/**
 * LOCAL TEST pairs — the one table the local test market and the local test listing both read.
 *
 * Everything here is LOCAL TEST data for the local test stack only:
 *   - `start` is a TEST PRICE: an invented, round starting point for a synthetic price walk. It is not a feed,
 *     not a quote and not a claim about any real market.
 *   - tick, lot and minimum cost follow what a retail exchange uses for a coin of that price, so the order form
 *     and the book show believable decimals. They are LOCAL TEST values, not an owner-published listing.
 *   - nothing in this file reaches production: the production catalogue is packages/contracts/src/instruments.ts
 *     and its seed migration. A pair listed here exists only in the local test database (see
 *     tooling/scripts/local-test-listing.mjs).
 *
 * Field meanings:
 *   notional   quote units that one "unit" of book depth is worth; each level is this times a varied multiplier
 *   weight     relative share of the test taker's trades (BTC/USDT trades far more often than APT/USDT)
 *   gridBps    spacing of price levels, in basis points of the starting price (snapped up to the market tick); the
 *              spread is one to two of these, so a tighter grid is a tighter spread and more orders to move
 *   stepBps    largest single move of the price walk per re-quote, in basis points (volatility clustering scales it)
 *   decimals   `ledger.assets.decimals` for a base asset this table introduces (a declaration of intent only)
 */

export const LOCAL_TEST_LABEL = 'LOCAL TEST — invented test pair, TEST PRICES, not a market feed, not a real listing';

const pair = (base, quote, name, start, tick, lot, notional, weight, gridBps, stepBps, decimals = 8) => ({
  symbol: `${base}/${quote}`,
  base,
  quote,
  name,
  start,
  tick,
  lot,
  minNotional: '5',
  notional,
  weight,
  gridBps,
  stepBps,
  decimals,
});

export const LOCAL_PAIRS = [
  // USDT: the three pairs the production catalogue already lists, then seventeen LOCAL TEST listings.
  pair('BTC', 'USDT', 'Bitcoin', '65000', '0.01', '0.00001', 20000, 12, 0.8, 5),
  pair('ETH', 'USDT', 'Ether', '2600', '0.01', '0.0001', 12000, 9, 1.2, 6),
  pair('IFC', 'USDT', 'INTAFACED Coin', '1', '0.0001', '0.01', 500, 1, 6, 6),
  pair('SOL', 'USDT', 'Solana', '150', '0.01', '0.001', 6000, 6, 2, 8, 9),
  pair('BNB', 'USDT', 'BNB', '580', '0.01', '0.001', 5000, 3, 2, 6, 18),
  pair('XRP', 'USDT', 'XRP', '0.55', '0.0001', '0.1', 4000, 4, 4, 8, 6),
  pair('DOGE', 'USDT', 'Dogecoin', '0.13', '0.00001', '1', 3500, 4, 4, 10),
  pair('ADA', 'USDT', 'Cardano', '0.38', '0.0001', '0.1', 2500, 2.5, 4, 9, 6),
  pair('AVAX', 'USDT', 'Avalanche', '28', '0.01', '0.01', 2000, 2, 3.5, 9, 18),
  pair('LINK', 'USDT', 'Chainlink', '14', '0.001', '0.01', 2000, 2, 3.5, 9, 18),
  pair('DOT', 'USDT', 'Polkadot', '4.5', '0.001', '0.01', 1500, 1.5, 4, 9, 10),
  pair('POL', 'USDT', 'Polygon', '0.45', '0.0001', '0.1', 1500, 1.5, 5, 10, 18),
  pair('LTC', 'USDT', 'Litecoin', '70', '0.01', '0.001', 1500, 1.5, 3.5, 7, 8),
  pair('TRX', 'USDT', 'TRON', '0.16', '0.00001', '1', 2000, 2, 4, 7, 6),
  pair('TON', 'USDT', 'Toncoin', '5.2', '0.001', '0.01', 1500, 1.5, 4.5, 9, 9),
  pair('ARB', 'USDT', 'Arbitrum', '0.55', '0.0001', '0.1', 1000, 1.2, 5, 11, 18),
  pair('OP', 'USDT', 'Optimism', '1.6', '0.001', '0.01', 1000, 1.2, 5, 11, 18),
  pair('SUI', 'USDT', 'Sui', '2.1', '0.0001', '0.1', 1500, 1.5, 5, 11, 9),
  pair('APT', 'USDT', 'Aptos', '8.5', '0.001', '0.01', 1000, 1, 5, 11, 8),
  pair('NEAR', 'USDT', 'NEAR Protocol', '4.8', '0.001', '0.01', 1000, 1, 5, 11, 18),
  // USDC: a few, so the quote switcher has something under it.
  pair('BTC', 'USDC', 'Bitcoin', '65000', '0.01', '0.00001', 8000, 3, 0.8, 5),
  pair('ETH', 'USDC', 'Ether', '2600', '0.01', '0.0001', 5000, 2, 1.2, 6),
  pair('SOL', 'USDC', 'Solana', '150', '0.01', '0.001', 2500, 1.5, 2, 8, 9),
  pair('XRP', 'USDC', 'XRP', '0.55', '0.0001', '0.1', 1500, 1, 4, 8, 6),
  pair('DOGE', 'USDC', 'Dogecoin', '0.13', '0.00001', '1', 1200, 1, 4, 10),
  pair('LINK', 'USDC', 'Chainlink', '14', '0.001', '0.01', 800, 0.7, 3.5, 9, 18),
];

/** Bases the production catalogue and ledger already carry; every other base here is a LOCAL TEST addition. */
export const PRODUCTION_ASSETS = new Set(['BTC', 'ETH', 'IFC', 'USDT', 'USDC']);

export const pairBySymbol = (symbol) => LOCAL_PAIRS.find((p) => p.symbol === symbol) ?? null;

/** Pairs and assets that exist only because of this table (what `local-test-listing` adds to the local database). */
export const localOnlyPairs = () =>
  LOCAL_PAIRS.filter((p) => !['BTC/USDT', 'ETH/USDT', 'BTC/USDC', 'ETH/USDC', 'IFC/USDT'].includes(p.symbol));
export const localOnlyAssets = () => [
  ...new Map(LOCAL_PAIRS.filter((p) => !PRODUCTION_ASSETS.has(p.base)).map((p) => [p.base, { id: p.base, decimals: p.decimals }])).values(),
];
