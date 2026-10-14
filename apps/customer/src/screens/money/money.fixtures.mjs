// Illustrative data for the Money test only. Not real balances, prices or history: the numbers are invented but
// consistent, so the test can check the screen against its parts. These are WIRE shapes: the exact JSON the bank and
// the exchange REST API send, so the real data layer (apps/customer/src/data) parses them.
export { balances, emptyBalances, hourlyCandles, markets, tickers } from '../home/home.fixtures.mjs';

/**
 * tRPC wraps every answer as { result: { data } }.
 */
export const trpc = (data) => ({ result: { data } });

/**
 * bank.portfolio.summary for: USDT 4,100.00 · BTC 0.1 at 67,812.40 · ETH 0.5 at 3,200.10 · DOGE 5 at 0.12345 (a small
 * balance) · and one coin with no price. Sums (cents, half away from zero):
 *   total  4100 + 6781.24 + 1600.05 + 0.61725 = 12481.90725 -> 12,481.91
 *   cash   4,100.00 · crypto 8381.90725 -> 8,381.91
 *   change 0 + 181.24 + 25.05 - 0.0321 = 206.2579 -> +206.26
 */
export const summary = ({ unpriced = true, windowStart = null } = {}) => ({
  totalUsd: '12481.91',
  change24hUsd: '206.26',
  cashUsd: '4100.00',
  cryptoUsd: '8381.91',
  priced: [
    { asset: 'USDT', amount: '4100.00', priceUsd: '1', valueUsd: '4100', change24hUsd: '0', pair: null },
    { asset: 'BTC', amount: '0.1', priceUsd: '67812.40', valueUsd: '6781.24', change24hUsd: '181.24', pair: 'BTC/USDT' },
    { asset: 'ETH', amount: '0.5', priceUsd: '3200.10', valueUsd: '1600.05', change24hUsd: '25.05', pair: 'ETH/USDT' },
    { asset: 'DOGE', amount: '5', priceUsd: '0.12345', valueUsd: '0.61725', change24hUsd: '-0.0321', pair: 'DOGE/USDT' },
  ],
  unpriced: unpriced ? [{ asset: 'ZED', amount: '12', reason: 'no_market' }] : [],
  asOf: Date.now(),
  windowStart,
});

export const cashOnlySummary = () => ({
  totalUsd: '250.00',
  change24hUsd: '0.00',
  cashUsd: '250.00',
  cryptoUsd: '0.00',
  priced: [{ asset: 'USDT', amount: '250', priceUsd: '1', valueUsd: '250', change24hUsd: '0', pair: null }],
  unpriced: [],
  asOf: Date.now(),
  windowStart: null,
});

export const emptySummary = () => ({
  totalUsd: '0.00',
  change24hUsd: '0.00',
  cashUsd: '0.00',
  cryptoUsd: '0.00',
  priced: [],
  unpriced: [],
  asOf: Date.now(),
  windowStart: null,
});

/** bank.spaces.list: the main USDT account plus two named ones. */
export const spaces = () => [
  space('s0', 'USDT', 'primary', 'Main', '3800.00'),
  space('s1', 'USDT', 'named', 'Rent', '300.00'),
  space('s2', 'BTC', 'named', 'Long term', '0.04'),
];
function space(id, assetId, kind, name, balance) {
  return {
    id,
    assetId,
    kind,
    name,
    goalTarget: null,
    lockedUntil: null,
    balance,
    ledgerAccount: { ownerType: 'user', ownerId: 'u1', assetId, kind: 'available' },
  };
}

const row = (id, kind, direction, asset, amount, postedAt, extra = {}) => ({
  id,
  kind,
  direction,
  asset,
  amount,
  postedAt,
  txId: `tx-${id}`,
  counterparty: null,
  spaceName: null,
  ...extra,
});

/** Page one: 12 rows, newest first, with a cursor. */
export const activityPage1 = () => ({
  items: [
    row('a1', 'transfer_in', 'in', 'USDT', '50', '2026-10-14T09:15:00.000Z', { counterparty: { handle: 'maya' } }),
    row('a2', 'trade', 'out', 'USDT', '678.1240', '2026-10-14T08:02:00.000Z', { orderId: 'ord-1' }),
    row('a3', 'trade', 'in', 'BTC', '0.01', '2026-10-14T08:02:00.000Z', { orderId: 'ord-1' }),
    row('a4', 'fee', 'out', 'USDT', '0.6781', '2026-10-14T08:02:00.000Z', { orderId: 'ord-1' }),
    row('a5', 'transfer_out', 'out', 'USDT', '20', '2026-10-13T17:40:00.000Z', { counterparty: { handle: 'ola' } }),
    row('a6', 'transfer_in', 'in', 'USDT', '15', '2026-10-13T12:00:00.000Z'),
    row('a7', 'space_move', 'out', 'USDT', '300', '2026-10-12T20:30:00.000Z', { spaceName: 'Rent' }),
    row('a8', 'deposit', 'in', 'USDT', '1000', '2026-10-12T10:00:00.000Z'),
    row('a9', 'welcome_funds', 'in', 'USDT', '4000', '2026-10-10T06:00:00.000Z'),
    row('a10', 'payment', 'out', 'USDT', '12.5', '2026-10-09T15:00:00.000Z'),
    row('a11', 'withdrawal', 'out', 'USDT', '100', '2026-10-08T11:11:00.000Z'),
    row('a12', 'other', 'in', 'ETH', '0.2', '2026-10-07T09:00:00.000Z'),
  ],
  nextCursor: 'cursor-2',
});

/** Page two: older rows, the end of the history. */
export const activityPage2 = () => ({
  items: [
    row('b1', 'deposit', 'in', 'USDT', '250', '2026-10-05T10:00:00.000Z'),
    row('b2', 'trade', 'in', 'ETH', '0.5', '2026-10-04T10:00:00.000Z'),
    row('b3', 'transfer_in', 'in', 'USDT', '75', '2025-12-30T10:00:00.000Z', { counterparty: { handle: 'sam' } }),
  ],
  nextCursor: null,
});

// ── trades and orders (the trade service's wire shapes, as the desk reads them) ──────────────────────────────────────

const at = (iso) => ({ timestamp: Date.parse(iso), datetime: iso });
const fill = (id, iso, side, price, amount, cost, fee) => ({
  id,
  order: `order-${id}`,
  ...at(iso),
  symbol: 'BTC/USDT',
  type: 'market',
  side,
  takerOrMaker: 'taker',
  price,
  amount,
  cost,
  fee: { cost: fee, currency: side === 'buy' ? 'BTC' : 'USDT', rate: '0.001' },
});
/** Two fills, newest first: a buy of 0.00015 BTC and a sell of 0.002 BTC. */
export const fills = () => [
  fill('f1', '2026-10-14T08:02:00.000Z', 'buy', '65083.66', '0.00015', '9.762549', '0.00000015'),
  fill('f2', '2026-10-13T10:30:00.000Z', 'sell', '64000.00', '0.002', '128', '0.128'),
];

const order = (id, iso, side, price, amount, status, filled) => ({
  id,
  clientOrderId: `desk:${id}`,
  ...at(iso),
  lastTradeTimestamp: null,
  symbol: 'BTC/USDT',
  type: 'limit',
  side,
  timeInForce: 'GTC',
  postOnly: false,
  reduceOnly: false,
  price,
  stopPrice: null,
  average: null,
  amount,
  filled,
  remaining: String(Number(amount) - Number(filled)),
  cost: '0',
  status,
  fee: null,
  trades: [],
  recoveryRequired: false,
  recoveryReason: null,
  reconciliationKey: null,
});
export const openOrders = () => [order('o1', '2026-10-14T09:00:00.000Z', 'buy', '62500.00', '0.00008', 'open', '0')];
export const closedOrders = () => [
  order('o2', '2026-10-14T08:01:00.000Z', 'buy', '65100.00', '0.00015', 'closed', '0.00015'),
  order('o3', '2026-10-13T17:00:00.000Z', 'buy', '60000.00', '0.0001', 'canceled', '0'),
];

/** A real buy as the server files it: the money set aside, the coin, the unused part returned. One `orderId`. */
export const buyLines = () => [
  row('h3', 'order_release', 'in', 'USDT', '0.032542', '2026-10-14T09:30:00.115Z', { orderId: 'ord-buy' }),
  row('h2', 'trade', 'in', 'BTC', '0.0000999', '2026-10-14T09:30:00.093Z', { orderId: 'ord-buy' }),
  row('h1', 'order_hold', 'out', 'USDT', '6.540908', '2026-10-14T09:30:00.072Z', { orderId: 'ord-buy' }),
];
/** A resting order that was cancelled: 5 USDT set aside, the same 5 returned. */
export const holdLines = () => [
  row('r2', 'order_release', 'in', 'USDT', '5', '2026-10-14T09:10:00.000Z', { orderId: 'ord-cancel' }),
  row('r1', 'order_hold', 'out', 'USDT', '5', '2026-10-14T09:05:00.000Z', { orderId: 'ord-cancel' }),
];
/** The same lines as a server that does not send `orderId` yet files them: holds and releases are `other`. */
export const olderServerLines = () =>
  [...holdLines(), ...buyLines()].map(({ orderId: _orderId, ...line }) => ({
    ...line,
    kind: line.kind === 'order_hold' || line.kind === 'order_release' ? 'other' : line.kind,
  }));
