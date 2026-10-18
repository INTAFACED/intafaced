import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { BybitSpotTrade, mapBybitSpotOrder } from './bybit-spot-trade.js';
import { mapOkxSpotOrder, OkxSpotTrade } from './okx-spot-trade.js';
import type { HttpPort, HttpRequestInit, HttpResponse } from '../transport.js';

// Synthetic transport fixtures only: no credentials or requests reach a venue.
const CLOCK = () => 1_700_000_000_000;
const AMOUNT = parseAmount('0.25');
const okxRow = (overrides: Record<string, unknown> = {}) => ({
  ordId: 'fixture-order',
  clOrdId: 'fixture-client',
  side: 'buy',
  ordType: 'market',
  sz: '0.25',
  accFillSz: '0.1',
  avgPx: '30000',
  px: '',
  state: 'partially_filled',
  tgtCcy: 'base_ccy',
  cTime: String(CLOCK()),
  ...overrides,
});

const bybitRow = (overrides: Record<string, unknown> = {}) => ({
  orderId: 'fixture-order',
  orderLinkId: 'fixture-client',
  side: 'Buy',
  orderType: 'Market',
  qty: '0.25',
  cumExecQty: '0.1',
  avgPrice: '30000',
  price: '0',
  orderStatus: 'PartiallyFilled',
  marketUnit: 'baseCoin',
  createdTime: String(CLOCK()),
  ...overrides,
});

function response(body: unknown): HttpResponse {
  return { status: 200, body, header: () => null };
}

function fixtureHttp(venue: 'bybit' | 'okx', side: 'buy' | 'sell', type: 'market' | 'limit') {
  const posts: unknown[] = [];
  const http: HttpPort = {
    async get(url) {
      if (url.includes('/market/orderbook')) {
        return response({
          retCode: 0,
          result: {
            s: 'BTCUSDT',
            b: [['30000', '2']],
            a: [['30002', '2']],
            u: 1,
            seq: 1,
            ts: CLOCK(),
          },
        });
      }
      if (url.includes('/market/books')) {
        return response({
          code: '0',
          data: [
            {
              bids: [['30000', '2', '0', '1']],
              asks: [['30002', '2', '0', '1']],
              ts: String(CLOCK()),
              seqId: 1,
            },
          ],
        });
      }
      if (venue === 'bybit' && url.includes('/order/realtime')) {
        return response({
          retCode: 0,
          result: {
            list: [
              {
                orderId: 'fixture-order',
                orderLinkId: 'fixture-client',
                side: side === 'buy' ? 'Buy' : 'Sell',
                orderType: type === 'market' ? 'Market' : 'Limit',
                qty: '0.25',
                cumExecQty: '0.1',
                avgPrice: '30000',
                price: type === 'limit' ? '30000' : '0',
                orderStatus: 'PartiallyFilled',
                marketUnit: 'baseCoin',
                createdTime: String(CLOCK()),
              },
            ],
          },
        });
      }
      if (venue === 'okx' && url.includes('/trade/order?')) {
        return response({ code: '0', data: [okxRow({ side, ordType: type, px: type === 'limit' ? '30000' : '' })] });
      }
      throw new Error(`Unexpected fixture GET: ${url}`);
    },
    async post(url, init?: HttpRequestInit) {
      posts.push(init?.jsonBody);
      if (venue === 'bybit' && url.endsWith('/v5/order/create')) {
        return response({ retCode: 0, result: { orderId: 'fixture-order', orderLinkId: 'fixture-client' } });
      }
      if (venue === 'okx' && url.endsWith('/api/v5/trade/order')) {
        return response({ code: '0', data: [{ ordId: 'fixture-order', clOrdId: 'fixture-client', sCode: '0' }] });
      }
      throw new Error(`Unexpected fixture POST: ${url}`);
    },
  };
  return { http, posts };
}

describe('spot placement keeps base quantity across venue market-order defaults', () => {
  for (const venue of ['bybit', 'okx'] as const) {
    for (const side of ['buy', 'sell'] as const) {
      for (const type of ['market', 'limit'] as const) {
        it(`${venue} ${side} ${type} sends the caller's base quantity`, async () => {
          const { http, posts } = fixtureHttp(venue, side, type);
          const credentials = {
            venueId: `${venue}-spot`,
            apiKey: 'fixture-key',
            apiSecret: 'fixture-secret',
            passphrase: 'fixture-passphrase',
            scopes: ['read', 'trade'],
          };
          const options = { http, clock: CLOCK, snapshotLimit: 5 };
          const adapter = venue === 'bybit' ? new BybitSpotTrade(credentials, options) : new OkxSpotTrade(credentials, options);
          const order = await adapter.placeOrder({
            symbol: 'BTC/USDT',
            side,
            type,
            amount: AMOUNT,
            clientOrderId: 'fixture-client',
            ...(type === 'limit' ? { price: parseAmount('30000') } : {}),
          });
          expect(posts).toHaveLength(1);
          const body = posts[0] as Record<string, string>;
          expect(body[venue === 'bybit' ? 'qty' : 'sz']).toBe('0.25');
          expect(body[venue === 'bybit' ? 'marketUnit' : 'tgtCcy']).toBe(
            type === 'market' ? (venue === 'bybit' ? 'baseCoin' : 'base_ccy') : undefined,
          );
          expect(order.amount).toBe(AMOUNT);
          expect(order.filled).toBe(parseAmount('0.1'));
          expect(order.remaining).toBe(parseAmount('0.15'));
        });
      }
    }
  }
});

describe('OKX observations never subtract base fills from quote quantity', () => {
  for (const side of ['buy', 'sell'] as const) {
    it.each(['quote_ccy', 'unknown'])(`refuses ${side} market size with tgtCcy=%s`, (tgtCcy) => {
      expect(() => mapOkxSpotOrder(okxRow({ side, tgtCcy, sz: '100' }), 'BTC/USDT', new Date(CLOCK()))).toThrow(/quantity unit/);
    });
    it(`preserves exact base-sized ${side} market quantities`, () => {
      const order = mapOkxSpotOrder(okxRow({ side }), 'BTC/USDT', new Date(CLOCK()));
      expect(order.amount).toBe(AMOUNT);
      expect(order.filled).toBe(parseAmount('0.1'));
      expect(order.remaining).toBe(parseAmount('0.15'));
    });
  }
  it.each([undefined, null, ''])('refuses missing/empty buy quantity unit (%s)', (tgtCcy) => {
    expect(() => mapOkxSpotOrder(okxRow({ tgtCcy, sz: '100' }), 'BTC/USDT', new Date(CLOCK()))).toThrow(/quantity unit/);
  });
  it.each([undefined, null, ''])('uses documented base default for sells (%s)', (tgtCcy) => {
    const order = mapOkxSpotOrder(okxRow({ side: 'sell', tgtCcy }), 'BTC/USDT', new Date(CLOCK()));
    expect(order.remaining).toBe(parseAmount('0.15'));
  });
  it.each(['limit', 'post_only'])('preserves base-sized %s quantities without tgtCcy', (ordType) => {
    const order = mapOkxSpotOrder(okxRow({ ordType, px: '30000', tgtCcy: '' }), 'BTC/USDT', new Date(CLOCK()));
    expect(order.remaining).toBe(parseAmount('0.15'));
  });
});

describe('Bybit observations never subtract base fills from quote quantity', () => {
  const map = (row: Record<string, unknown>) => mapBybitSpotOrder(row, 'BTC/USDT', new Date(CLOCK()));
  for (const side of ['Buy', 'Sell'] as const) {
    it.each(['quoteCoin', 'unknown'])(`refuses ${side} market qty with marketUnit=%s`, (marketUnit) => {
      expect(() => map(bybitRow({ side, marketUnit, qty: '100' }))).toThrow(/quantity unit/);
    });
    it(`preserves exact base-sized ${side} market quantities`, () => {
      const order = map(bybitRow({ side }));
      expect(order.amount).toBe(AMOUNT);
      expect(order.filled).toBe(parseAmount('0.1'));
      expect(order.remaining).toBe(parseAmount('0.15'));
    });
  }
  it.each([undefined, null, ''])('refuses missing/empty buy market quantity unit (%s)', (marketUnit) => {
    expect(() => map(bybitRow({ marketUnit, qty: '100' }))).toThrow(/quantity unit/);
  });
  it.each([undefined, null, ''])('uses documented base default for sells (%s)', (marketUnit) => {
    const order = map(bybitRow({ side: 'Sell', marketUnit }));
    expect(order.remaining).toBe(parseAmount('0.15'));
  });
  it('marks the refusal as sent when the order was already placed', () => {
    expect(() => mapBybitSpotOrder(bybitRow({ marketUnit: 'quoteCoin', qty: '100' }), 'BTC/USDT', new Date(CLOCK()), true)).toThrow(
      expect.objectContaining({ sent: true }),
    );
  });
  it.each(['quoteCoin', '', 'unknown'])('leaves limit orders unaffected by marketUnit=%s', (marketUnit) => {
    const order = map(bybitRow({ orderType: 'Limit', price: '30000', marketUnit }));
    expect(order.remaining).toBe(parseAmount('0.15'));
  });
});
