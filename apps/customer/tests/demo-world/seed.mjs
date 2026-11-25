/**
 * THE DEMO WORLD'S SEEDED TRADER: one TEST account on the venue, with balances, two open positions, resting orders and
 * fills, priced from the recorded venue feed (recording.json) so its marks and profit agree with the book beside them.
 * Every figure is TEST and invented; nothing here is a real account. The answers are svc-trade's door's wire shapes
 * (packages/contracts/src/trade-venue-door.ts), so the app's own schemas read them.
 *
 * The trader's wallet is the browser TEST wallet (../test-wallet.mjs) with demoWalletKey(): a fixed TEST key, never
 * funded anywhere, so every picture shows the same address.
 */

import { keccak256, toHex } from 'viem';

/** The demo wallet's TEST key: the keccak of a label (as the journeys' TEST keys are), never funded on any network. */
export const demoWalletKey = () => keccak256(toHex('intafaced TEST demo wallet'));

const SCALE = 10n ** 8n;
/** A decimal string as a scaled bigint (8 places), and back: money never passes through a float here either. */
const big = (s) => {
  const [w, f = ''] = String(s).split('.');
  const neg = w.startsWith('-');
  const v = BigInt(w.replace('-', '') || '0') * SCALE + BigInt((f + '00000000').slice(0, 8));
  return neg ? -v : v;
};
const dec = (v, places = 8) => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const f = (a % SCALE).toString().padStart(8, '0').slice(0, places).replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / SCALE}${f ? `.${f}` : ''}`;
};
const mul = (a, b) => (a * b) / SCALE;

/** The recorded mid of `symbol` (best bid and ask), or null when the recording has none. */
function recordedMid(calls, symbol) {
  const best = calls[`GET /api/v1/venue/best-prices?symbol=${symbol}`]?.json?.value;
  if (!best?.bid || !best?.ask) return null;
  return (big(best.bid) + big(best.ask)) / 2n;
}

/**
 * The seeded trader's venue reads, keyed by the door's path: `{ status, json }`, or a function of the request's URL. `now` is the picture's
 * time; `venueId` the recorded venue's.
 */
export function seededAccount(calls, { now, venueId }) {
  const at = (msAgo) => new Date(now - msAgo).toISOString();
  const asOf = (value) => ({ status: 200, json: { venueId, value, asOf: at(0), reportedAt: at(0), test: true } });
  const btc = recordedMid(calls, 'BTC-PERP') ?? big('58000');
  const eth = recordedMid(calls, 'ETH-PERP') ?? big('1650');
  // Two positions opened earlier: long BTC a little below the mark, short ETH a little above it.
  const positions = [
    { symbol: 'BTC-PERP', side: 'long', size: big('0.25'), entry: (btc * 98n) / 100n, lev: 10n },
    { symbol: 'ETH-PERP', side: 'short', size: big('3'), entry: (eth * 103n) / 100n, lev: 5n },
  ].map((p) => {
    const pnl = mul(p.side === 'long' ? btc - p.entry : p.entry - (p.symbol === 'ETH-PERP' ? eth : btc), p.size);
    const mark = p.symbol === 'ETH-PERP' ? eth : btc;
    const margin = mul(p.entry, p.size) / p.lev;
    const liq = p.side === 'long' ? (p.entry * (100n - 100n / p.lev + 2n)) / 100n : (p.entry * (100n + 100n / p.lev - 2n)) / 100n;
    return {
      symbol: p.symbol,
      side: p.side,
      size: dec(p.size),
      entryPrice: dec(p.entry, 1),
      markPrice: dec(mark, 1),
      unrealisedPnl: dec(pnl, 2),
      marginMode: 'cross',
      margin: dec(margin, 2),
      leverageBps: Number(p.lev) * 10_000,
      liquidationPrice: { known: true, value: dec(liq, 1) },
      maintenanceMargin: { known: true, value: dec(margin / 4n, 2) },
      _pnl: pnl,
      _margin: margin,
    };
  });
  const usedMargin = positions.reduce((s, p) => s + p._margin, 0n);
  const upnl = positions.reduce((s, p) => s + p._pnl, 0n);
  const collateral = big('25000');
  const equity = collateral + upnl;
  const order = (id, symbol, side, amount, price, minsAgo, extra = {}) => ({
    venueOrderId: String(id),
    venueClientOrderId: `0x${String(id).padStart(32, '0')}`,
    symbol,
    side,
    type: 'limit',
    timeInForce: 'GTC',
    price: dec(price, 2),
    amount,
    filled: '0',
    remaining: amount,
    averagePrice: null,
    status: 'open',
    locked: '0',
    lockedAsset: 'USDC-PERP',
    reduceOnly: false,
    trigger: null,
    cancelReason: null,
    origin: 'user',
    originRef: null,
    label: null,
    _placedAt: at(minsAgo * 60_000),
    ...extra,
  });
  const open = [
    order(910001, 'BTC-PERP', 'buy', '0.1', (btc * 96n) / 100n, 42),
    order(910002, 'BTC-PERP', 'sell', '0.05', (btc * 104n) / 100n, 18),
    order(910003, 'ETH-PERP', 'buy', '1.5', (eth * 97n) / 100n, 7),
  ];
  const fill = (id, symbol, side, amount, price, minsAgo, role, pnl = null) => ({
    fillId: String(id),
    venueClientOrderId: `0x${String(id).padStart(32, '0')}`,
    symbol,
    side,
    price: dec(price, 1),
    amount,
    role,
    venueFee: dec(mul(mul(price, big(amount)), big('0.00035')), 4),
    builderFee: '0',
    feeAsset: 'USDC',
    realisedPnl: pnl,
    filledAt: at(minsAgo * 60_000),
  });
  const fills = [
    fill(920005, 'ETH-PERP', 'sell', '3', (eth * 103n) / 100n, 95, 'taker'),
    fill(920004, 'BTC-PERP', 'buy', '0.15', (btc * 98n) / 100n, 160, 'maker'),
    fill(920003, 'BTC-PERP', 'buy', '0.1', (btc * 98n) / 100n, 170, 'taker'),
    fill(920002, 'BTC-PERP', 'sell', '0.2', (btc * 99n) / 100n, 60 * 26, 'taker', '84.12'),
    fill(920001, 'BTC-PERP', 'buy', '0.2', (btc * 97n) / 100n, 60 * 30, 'maker'),
  ];
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
  const filled = fills.map((f) => ({
    order: strip(
      order(f.fillId, f.symbol, f.side, f.amount, big(f.price), 0, {
        type: f.role === 'maker' ? 'limit' : 'market',
        filled: f.amount,
        remaining: '0',
        averagePrice: f.price,
        status: 'filled',
      }),
    ),
    placedAt: f.filledAt,
  }));
  return {
    '/api/v1/venue/balances': asOf([
      { asset: 'USDC', free: '8250.5', locked: '0', total: '8250.5' },
      { asset: 'PURR', free: '1200', locked: '0', total: '1200' },
      {
        asset: 'USDC-PERP',
        free: dec(equity - usedMargin, 2),
        locked: dec(usedMargin, 2),
        total: dec(equity, 2),
        lockedBy: { inOrders: '0', margin: dec(usedMargin, 2), staked: '0' },
      },
    ]),
    '/api/v1/venue/positions': asOf(positions.map(strip)),
    '/api/v1/venue/orders/open': asOf(open.map(strip)),
    '/api/v1/venue/fills': asOf(fills),
    '/api/v1/venue/orders/history': {
      status: 200,
      json: {
        venueId,
        orders: [...open.map((o) => ({ order: strip(o), placedAt: o._placedAt })), ...filled],
        next: null,
        asOf: at(0),
      },
    },
    // The leverage the trader set on each contract they hold, else the venue's default of 10x cross.
    '/api/v1/venue/leverage': (u) => {
      const symbol = u.searchParams.get('symbol');
      const held = positions.find((p) => p.symbol === symbol);
      return asOf(symbol ? { symbol, leverageBps: held?.leverageBps ?? 100_000, marginMode: 'cross' } : null);
    },
    '/api/v1/venue/account-mode': asOf({ mode: 'standard', spot: null, perps: null, actions: null }),
    // The builder fee the trader approved for us, in percent as the venue holds it (TEST).
    '/api/v1/venue/builder-fee-approval': asOf('0.01'),
    // The venue's own fee schedule and a fresh account's rates on it, as the recorder read them from the venue (no volume
    // yet, so every account's): null where the recording has none, and the call is then refused as unanswered.
    ...(calls['GET /api/v1/venue/fee-tier'] ? { '/api/v1/venue/fee-tier': calls['GET /api/v1/venue/fee-tier'] } : {}),
    // No trading session started on this device yet: the desk offers to start one.
    '/api/v1/venue/session': (u) => ({
      status: 200,
      json: { venueId, owner: (u.searchParams.get('owner') ?? '').toLowerCase(), current: null, asOf: at(0) },
    }),
    '/api/v1/venue/account-summary': asOf({
      asset: 'USDC',
      equity: dec(equity, 2),
      free: dec(equity - usedMargin, 2),
      usedMargin: dec(usedMargin, 2),
      maintenanceMargin: dec(usedMargin / 4n, 2),
      marginRatio: { known: true, value: dec((usedMargin * SCALE) / 4n / equity, 4) },
      cross: null,
    }),
  };
}
