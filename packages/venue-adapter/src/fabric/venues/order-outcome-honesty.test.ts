import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueUnavailableError } from '@intafaced/venue-contracts';
import { BinanceSpotTrade, mapBinanceSpotOrder } from './binance-spot-trade.js';
import { BybitSpotTrade, mapBybitSpotOrder } from './bybit-spot-trade.js';
import { OkxSpotTrade, mapOkxSpotOrder } from './okx-spot-trade.js';
import {
  assertFillReportMatchesStatus,
  assertKnownOrderStatus,
  isTimeoutOrAbort,
  throwVenueTransportFailure,
} from './order-outcome-honesty.js';
import type { HttpPort, HttpResponse } from '../transport.js';

const NOW = new Date('2026-08-26T00:00:00.000Z');

const KEYS = {
  venueId: 'binance-spot' as const,
  apiKey: 'k',
  apiSecret: 's',
  scopes: ['read', 'trade'] as const,
};

const BYBIT_KEYS = {
  venueId: 'bybit-spot' as const,
  apiKey: 'k',
  apiSecret: 's',
  scopes: ['read', 'trade'] as const,
};

const OKX_KEYS = {
  venueId: 'okx-spot' as const,
  apiKey: 'k',
  apiSecret: 's',
  passphrase: 'p',
  scopes: ['read', 'trade'] as const,
};

class TimeoutHttp implements HttpPort {
  constructor(private readonly err: Error) {}
  async get(): Promise<HttpResponse> {
    throw this.err;
  }
  async post(): Promise<HttpResponse> {
    throw this.err;
  }
  async delete(): Promise<HttpResponse> {
    throw this.err;
  }
}

function abort(name: 'TimeoutError' | 'AbortError'): Error {
  const error = new Error(name === 'TimeoutError' ? 'The operation timed out' : 'This operation was aborted');
  error.name = name;
  return error;
}

function binanceBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: 42,
    clientOrderId: 'abc',
    transactTime: 1_500_000_000_000,
    price: '100',
    origQty: '1',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    type: 'LIMIT',
    side: 'BUY',
    ...over,
  };
}

function bybitRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: '9',
    orderLinkId: 'abc',
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Limit',
    price: '1',
    qty: '1',
    cumExecQty: '0',
    avgPrice: '0',
    orderStatus: 'New',
    createdTime: '1',
    ...over,
  };
}

function okxRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instId: 'BTC-USDT',
    ordId: '1',
    clOrdId: 'abc',
    px: '30000',
    sz: '1',
    accFillSz: '0',
    avgPx: '0',
    state: 'live',
    side: 'buy',
    ordType: 'limit',
    cTime: '1700000000000',
    ...over,
  };
}

function expectUnknownNotFill(run: () => unknown): void {
  expect(run).toThrow(VenueUnavailableError);
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(VenueUnavailableError);
    expect(String((error as Error).message)).toMatch(/outcome unknown, not a fill/);
    expect(String((error as Error).message)).not.toMatch(/^filled$/i);
  }
}

describe('order-outcome-honesty — M22 unknown stays unknown', () => {
  it('classifies timeout and abort, not ordinary transport errors', () => {
    expect(isTimeoutOrAbort(abort('TimeoutError'))).toBe(true);
    expect(isTimeoutOrAbort(abort('AbortError'))).toBe(true);
    expect(isTimeoutOrAbort(new Error('socket hang up'))).toBe(false);
  });

  it('timeout throw is unreachable, never a filled order', () => {
    expect(() => throwVenueTransportFailure('binance-spot', 'GET', '/api/v3/order', abort('TimeoutError'))).toThrow(VenueUnavailableError);
    try {
      throwVenueTransportFailure('binance-spot', 'GET', '/api/v3/order', abort('TimeoutError'));
    } catch (error) {
      expect((error as VenueUnavailableError).reason).toBe('unreachable');
      expect((error as Error).message).toMatch(/timed out — outcome unknown, not a fill/);
    }
  });

  it('unknown status fences instead of mapping to filled', () => {
    expectUnknownNotFill(() => assertKnownOrderStatus('binance-spot', undefined, 'WEIRD', 'order status'));
  });

  it('filled with zero size or missing average price is not a fill', () => {
    expectUnknownNotFill(() => assertFillReportMatchesStatus('binance-spot', 'filled', 0n, 1n));
    expectUnknownNotFill(() => assertFillReportMatchesStatus('binance-spot', 'filled', 1n, null));
    expectUnknownNotFill(() => assertFillReportMatchesStatus('okx-spot', 'partially_filled', 0n, null));
    expect(() => assertFillReportMatchesStatus('binance-spot', 'open', 0n, null)).not.toThrow();
    expect(() => assertFillReportMatchesStatus('binance-spot', 'filled', 1n, 100n)).not.toThrow();
  });
});

describe('CEX mappers — unknown / missing fill / no invented fee', () => {
  it('Binance unknown status and FILLED-without-fills refuse, fees stay null', () => {
    expectUnknownNotFill(() => mapBinanceSpotOrder(binanceBody({ status: 'UNKNOWN' }), 'BTC/USDT', NOW));
    expectUnknownNotFill(() =>
      mapBinanceSpotOrder(binanceBody({ status: 'FILLED', executedQty: '0', cummulativeQuoteQty: '0' }), 'BTC/USDT', NOW),
    );
    const open = mapBinanceSpotOrder(binanceBody(), 'BTC/USDT', NOW);
    expect(open.status).toBe('open');
    expect(open.feePaid).toBeNull();
    expect(open.feeAsset).toBeNull();
    const filled = mapBinanceSpotOrder(binanceBody({ status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '100' }), 'BTC/USDT', NOW);
    expect(filled.status).toBe('filled');
    expect(filled.feePaid).toBeNull();
  });

  it('Bybit unknown status and Filled-without-fills refuse, fees stay null', () => {
    expectUnknownNotFill(() => mapBybitSpotOrder(bybitRow({ orderStatus: 'Created' }), 'BTC/USDT', NOW));
    expectUnknownNotFill(() => mapBybitSpotOrder(bybitRow({ orderStatus: 'Filled', cumExecQty: '0' }), 'BTC/USDT', NOW));
    expectUnknownNotFill(() => mapBybitSpotOrder(bybitRow({ orderStatus: 'Filled', cumExecQty: '1', avgPrice: '0' }), 'BTC/USDT', NOW));
    const open = mapBybitSpotOrder(bybitRow(), 'BTC/USDT', NOW);
    expect(open.status).toBe('open');
    expect(open.feePaid).toBeNull();
  });

  it('OKX unknown state and filled-without-fills refuse, fees stay null', () => {
    expectUnknownNotFill(() => mapOkxSpotOrder(okxRow({ state: 'mmp_canceled' }), 'BTC/USDT', NOW));
    expectUnknownNotFill(() => mapOkxSpotOrder(okxRow({ state: 'filled', accFillSz: '0' }), 'BTC/USDT', NOW));
    expectUnknownNotFill(() => mapOkxSpotOrder(okxRow({ state: 'filled', accFillSz: '1', avgPx: '0' }), 'BTC/USDT', NOW));
    const open = mapOkxSpotOrder(okxRow(), 'BTC/USDT', NOW);
    expect(open.status).toBe('open');
    expect(open.feePaid).toBeNull();
  });

  it('does not subtract base accFillSz from quote sz on a spot market buy', () => {
    const quoteBuy = okxRow({
      ordType: 'market',
      side: 'buy',
      px: '',
      sz: '100',
      accFillSz: '0.00192834',
      avgPx: '51858',
      state: 'filled',
      tgtCcy: 'quote_ccy',
    });
    const defaultQuoteBuy = { ...quoteBuy };
    delete defaultQuoteBuy.tgtCcy;
    for (const row of [quoteBuy, defaultQuoteBuy]) {
      expect(() => mapOkxSpotOrder(row, 'BTC/USDT', NOW)).toThrow(VenueUnavailableError);
      try {
        mapOkxSpotOrder(row, 'BTC/USDT', NOW);
      } catch (error) {
        expect(error).toBeInstanceOf(VenueUnavailableError);
        expect((error as VenueUnavailableError).reason).toBe('malformed');
        expect(String((error as Error).message)).toMatch(/quote/);
      }
    }

    const limit = mapOkxSpotOrder(
      okxRow({ sz: '1', accFillSz: '0.4', avgPx: '30000', state: 'partially_filled' }),
      'BTC/USDT',
      NOW,
    );
    expect(limit.amount).toBe(parseAmount('1'));
    expect(limit.filled).toBe(parseAmount('0.4'));
    expect(limit.remaining).toBe(parseAmount('1') - parseAmount('0.4'));

    const baseBuy = mapOkxSpotOrder(
      okxRow({
        ordType: 'market',
        side: 'buy',
        px: '',
        sz: '1',
        accFillSz: '0.4',
        avgPx: '30000',
        state: 'partially_filled',
        tgtCcy: 'base_ccy',
      }),
      'BTC/USDT',
      NOW,
    );
    expect(baseBuy.amount).toBe(parseAmount('1'));
    expect(baseBuy.filled).toBe(parseAmount('0.4'));
    expect(baseBuy.remaining).toBe(parseAmount('1') - parseAmount('0.4'));
  });
});

describe('trade adapters — timeout after dispatch is unknown, not filled', () => {
  it('Binance fetchOrder timeout does not return filled', async () => {
    const trade = new BinanceSpotTrade(KEYS, { http: new TimeoutHttp(abort('TimeoutError')), clock: () => 1 });
    await expect(trade.fetchOrder('BTC/USDT', 'abc')).rejects.toMatchObject({
      reason: 'unreachable',
      message: expect.stringMatching(/timed out — outcome unknown, not a fill/),
    });
  });

  it('Bybit fetchOrder abort does not return filled', async () => {
    const trade = new BybitSpotTrade(BYBIT_KEYS, { http: new TimeoutHttp(abort('AbortError')), clock: () => 1 });
    await expect(trade.fetchOrder('BTC/USDT', 'abc')).rejects.toMatchObject({
      reason: 'unreachable',
      message: expect.stringMatching(/timed out — outcome unknown, not a fill/),
    });
  });

  it('OKX fetchOrder timeout does not return filled', async () => {
    const trade = new OkxSpotTrade(OKX_KEYS, { http: new TimeoutHttp(abort('TimeoutError')), clock: () => 1 });
    await expect(trade.fetchOrder('BTC/USDT', 'abc')).rejects.toMatchObject({
      reason: 'unreachable',
      message: expect.stringMatching(/timed out — outcome unknown, not a fill/),
    });
  });
});
