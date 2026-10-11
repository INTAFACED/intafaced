import { describe, expect, it, vi } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client/money';
import { VenueUnavailableError } from '@intafaced/venue-contracts';
import { createVenueAccountAdapter, createVenueTradeAdapter } from './factory.js';
import { mapBinanceSpotBalances } from './binance-spot-account.js';
import { mapBybitSpotCoins } from './bybit-spot-account.js';
import { mapBybitSpotOrder } from './bybit-spot-trade.js';
import { mapOkxSpotDetails } from './okx-spot-account.js';
import { mapOkxSpotOrder } from './okx-spot-trade.js';

const now = new Date('2026-08-20T00:00:00.000Z');

const bybitOrder = () => ({
  orderStatus: 'PartiallyFilled',
  qty: '2',
  cumExecQty: '0.5',
  avgPrice: '30000.125',
  orderType: 'Limit',
  price: '30001',
  createdTime: '1700000000000',
  orderId: 'venue-1',
  orderLinkId: 'client-1',
  side: 'Buy',
});

const okxOrder = () => ({
  state: 'partially_filled',
  sz: '2',
  accFillSz: '0.5',
  avgPx: '30000.125',
  ordType: 'limit',
  px: '30001',
  cTime: '1700000000000',
  ordId: 'venue-1',
  clOrdId: 'client-1',
  side: 'buy',
});

describe('signed venue order normalization refuses plausible malformed data', () => {
  it('preserves fixed-point values and caller/venue identifiers', () => {
    const bybit = mapBybitSpotOrder(bybitOrder(), 'BTC/USDT', now);
    const okx = mapOkxSpotOrder(okxOrder(), 'BTC/USDT', now);
    for (const order of [bybit, okx]) {
      expect(order.venueOrderId).toBe('venue-1');
      expect(order.clientOrderId).toBe('client-1');
      expect(order.symbol).toBe('BTC/USDT');
      expect(formatAmount(order.amount)).toBe('2');
      expect(formatAmount(order.filled)).toBe('0.5');
      expect(formatAmount(order.remaining)).toBe('1.5');
      expect(formatAmount(order.averagePrice!)).toBe('30000.125');
    }
  });

  const corruptions: Array<[string, (row: Record<string, unknown>) => void]> = [
    ['unknown side', (row) => (row.side = 'hold')],
    ['unknown type', (row) => (row.orderType = row.ordType = 'iceberg')],
    ['zero amount', (row) => (row.qty = row.sz = '0')],
    ['negative fill', (row) => (row.cumExecQty = row.accFillSz = '-1')],
    ['fill above amount', (row) => (row.cumExecQty = row.accFillSz = '3')],
    ['missing venue id', (row) => (row.orderId = row.ordId = '')],
    ['missing client id', (row) => (row.orderLinkId = row.clOrdId = '')],
    ['zero average after fill', (row) => (row.avgPrice = row.avgPx = '0')],
    ['zero limit price', (row) => (row.price = row.px = '0')],
  ];

  for (const [name, corrupt] of corruptions) {
    it(`refuses ${name} for Bybit and OKX`, () => {
      const bybit = bybitOrder() as Record<string, unknown>;
      const okx = okxOrder() as Record<string, unknown>;
      corrupt(bybit);
      corrupt(okx);
      expect(() => mapBybitSpotOrder(bybit, 'BTC/USDT', now)).toThrow();
      expect(() => mapOkxSpotOrder(okx, 'BTC/USDT', now)).toThrow();
    });
  }
});

describe('signed venue balance observations refuse negative or anonymous rows', () => {
  it('keeps decimal strings as scaled amounts', () => {
    const [binance] = mapBinanceSpotBalances({ balances: [{ asset: 'usdt', free: '1.25', locked: '0.75' }] }, now);
    const [bybit] = mapBybitSpotCoins([{ coin: 'usdt', walletBalance: '2', locked: '0.75', availableToWithdraw: '1.25' }], now);
    const [okx] = mapOkxSpotDetails([{ ccy: 'usdt', availBal: '1.25', frozenBal: '0.75', eq: '2' }], now);
    for (const balance of [binance, bybit, okx]) {
      expect(balance!.asset).toBe('USDT');
      expect(formatAmount(balance!.free)).toBe('1.25');
      expect(formatAmount(balance!.used)).toBe('0.75');
      expect(formatAmount(balance!.total)).toBe('2');
    }
  });

  it('refuses missing assets and negative signed-looking values', () => {
    expect(() => mapBinanceSpotBalances({ balances: [{ asset: '', free: '1', locked: '0' }] }, now)).toThrow(VenueUnavailableError);
    expect(() => mapBybitSpotCoins([{ coin: '', walletBalance: '1', locked: '0' }], now)).toThrow(VenueUnavailableError);
    expect(() => mapOkxSpotDetails([{ ccy: '', availBal: '1', frozenBal: '0' }], now)).toThrow(VenueUnavailableError);
    expect(() => mapBinanceSpotBalances({ balances: [{ asset: 'USDT', free: '-1', locked: '0' }] }, now)).toThrow();
    expect(() => mapBybitSpotCoins([{ coin: 'USDT', walletBalance: '1', locked: '2' }], now)).toThrow(VenueUnavailableError);
    expect(() => mapOkxSpotDetails([{ ccy: 'USDT', availBal: '-1', frozenBal: '0' }], now)).toThrow();
  });
});

describe('signed venue factories expose exactly the coherent three-venue surface', () => {
  it('builds trade and account adapters for each registered public venue and refuses unknown/off', () => {
    for (const id of ['binance-spot', 'bybit-spot', 'okx-spot']) {
      expect(createVenueTradeAdapter(id)?.venue.id).toBe(id);
      expect(createVenueAccountAdapter(id)?.venue.id).toBe(id);
    }
    for (const id of ['', 'off', 'none', 'false', 'unknown']) {
      expect(createVenueTradeAdapter(id)).toBeNull();
      expect(createVenueAccountAdapter(id)).toBeNull();
    }
  });

  it('refuses credential venue confusion and withdrawal-capable keys at load time', () => {
    for (const id of ['binance-spot', 'bybit-spot', 'okx-spot']) {
      const wrongVenue = { venueId: 'wrong-spot', apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] };
      const dangerous = { venueId: id, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade', 'WITHDRAW'] };
      expect(() => createVenueTradeAdapter(id, wrongVenue)).toThrow();
      expect(() => createVenueAccountAdapter(id, wrongVenue)).toThrow();
      expect(() => createVenueTradeAdapter(id, dangerous)).toThrow();
      expect(() => createVenueAccountAdapter(id, dangerous)).toThrow();
    }
  });
});

describe('signed adapter input refusal before transport', () => {
  it.each(['bybit-spot', 'okx-spot'])('refuses invalid %s place input without HTTP', async (venueId) => {
    const get = vi.fn(async () => {
      throw new Error('unexpected fixture GET');
    });
    const post = vi.fn(async () => {
      throw new Error('unexpected fixture POST');
    });
    const keys = { venueId, apiKey: 'fixture-key', apiSecret: 'fixture-secret', passphrase: 'fixture-pass', scopes: ['read', 'trade'] };
    const request = {
      symbol: 'BTC/USDT',
      type: 'limit' as const,
      side: 'buy' as const,
      amount: 1n,
      price: 1n,
      clientOrderId: 'fixture-id',
    };
    for (const invalid of [{ amount: 0n }, { amount: -1n }, { price: 0n }, { price: -1n }, { clientOrderId: ' ' }, { symbol: 'BTCUSDT' }]) {
      const adapter = createVenueTradeAdapter(venueId, keys, { http: { get, post }, snapshotLimit: 5 });
      await expect(adapter!.placeOrder({ ...request, ...invalid })).rejects.toMatchObject({ reason: 'malformed' });
    }
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('preserves OKX post-only limit order observations and exact large decimal amounts', () => {
    const order = mapOkxSpotOrder({ ...okxOrder(), ordType: 'post_only', sz: '9007199254740993.000000000000000001' }, 'BTC/USDT', now);
    expect(order.type).toBe('limit');
    expect(formatAmount(order.amount)).toBe('9007199254740993.000000000000000001');
    expect(formatAmount(order.filled)).toBe('0.5');
  });

  it('retains outcome-unknown errors for a sized partial fill without a price', () => {
    expect(() => mapBybitSpotOrder({ ...bybitOrder(), avgPrice: '0' }, 'BTC/USDT', now)).toThrow(/outcome unknown, not a fill/);
    expect(() => mapOkxSpotOrder({ ...okxOrder(), avgPx: '0' }, 'BTC/USDT', now)).toThrow(/outcome unknown, not a fill/);
  });
});
