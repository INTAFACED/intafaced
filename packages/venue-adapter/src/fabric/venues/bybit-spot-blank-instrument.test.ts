import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { VenueUnavailableError } from '@intafaced/venue-contracts';
import type { HttpPort, HttpResponse, StreamPort } from '../transport.js';
import { BybitSpotMarketData } from './bybit-spot.js';

class FakeHttp implements HttpPort {
  readonly requests: string[] = [];
  #responses: HttpResponse[] = [];

  queue(body: unknown, status = 200): this {
    this.#responses.push({
      status,
      body,
      header: () => null,
    });
    return this;
  }

  async get(url: string): Promise<HttpResponse> {
    this.requests.push(url);
    const next = this.#responses.shift();
    if (!next) throw new Error(`FakeHttp had no queued response for ${url}`);
    return next;
  }
}

const silentStream: StreamPort = {
  async open() {
    throw new Error('blank-instrument test does not open a socket');
  },
};

function adapter(http: FakeHttp): BybitSpotMarketData {
  return new BybitSpotMarketData({
    http,
    stream: silentStream,
    restBase: 'https://rest.test',
    heartbeatMs: 0,
  });
}

function envelope(list: Record<string, unknown>[]): unknown {
  return {
    retCode: 0,
    retMsg: 'OK',
    result: { category: 'spot', list, nextPageCursor: '' },
    time: 1,
  };
}

function instrument(symbol: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
  const lot: Record<string, unknown> = {
    basePrecision: '0.000001',
    quotePrecision: '0.00000001',
    minOrderQty: '0.000048',
    maxOrderQty: '71.73956243',
    minOrderAmt: '1',
    maxLimitOrderQty: '80',
  };
  const row: Record<string, unknown> = {
    symbol,
    baseCoin: base,
    quoteCoin: 'USDT',
    status: 'Trading',
    lotSizeFilter: lot,
    priceFilter: { tickSize: '0.01' },
  };
  if ('lotSizeFilter' in patch) row.lotSizeFilter = patch.lotSizeFilter;
  else {
    for (const key of ['basePrecision', 'minOrderQty', 'minOrderAmt'] as const) {
      if (key in patch) lot[key] = patch[key];
    }
  }
  if ('priceFilter' in patch) row.priceFilter = patch.priceFilter;
  else if ('tickSize' in patch) row.priceFilter = { tickSize: patch.tickSize };
  return row;
}

describe('BybitSpotMarketData blank lot filter', () => {
  it('omits an instrument missing tickSize and keeps the published tick', async () => {
    const http = new FakeHttp().queue(
      envelope([instrument('ETHUSDT', { tickSize: null }), instrument('BTCUSDT', { tickSize: '0.01' })]),
    );
    const markets = await adapter(http).markets();

    expect(markets.map((market) => market.symbol)).toEqual(['BTC/USDT']);
    expect(formatAmount(markets[0]!.precision.price)).toBe('0.01');
    expect(markets[0]!.precision.price).not.toBe(parseAmount('0.00000001'));
  });

  it('omits an instrument missing basePrecision', async () => {
    const http = new FakeHttp().queue(
      envelope([instrument('SOLUSDT', { basePrecision: '' }), instrument('BTCUSDT')]),
    );
    const markets = await adapter(http).markets();
    expect(markets.map((market) => market.symbol)).toEqual(['BTC/USDT']);
  });

  it('omits an instrument missing minOrderQty', async () => {
    const http = new FakeHttp().queue(
      envelope([instrument('XRPUSDT', { minOrderQty: undefined }), instrument('BTCUSDT')]),
    );
    const markets = await adapter(http).markets();
    expect(markets.map((market) => market.symbol)).toEqual(['BTC/USDT']);
  });

  it('omits an instrument missing minOrderAmt', async () => {
    const http = new FakeHttp().queue(
      envelope([instrument('ADAUSDT', { minOrderAmt: '   ' }), instrument('BTCUSDT')]),
    );
    const markets = await adapter(http).markets();
    expect(markets.map((market) => market.symbol)).toEqual(['BTC/USDT']);
  });

  it('refuses the list when every instrument omitted a tick, lot, or minimum', async () => {
    const http = new FakeHttp().queue(
      envelope([
        instrument('ETHUSDT', { tickSize: null }),
        instrument('SOLUSDT', { basePrecision: '' }),
        instrument('XRPUSDT', { minOrderQty: undefined }),
        instrument('ADAUSDT', { minOrderAmt: null }),
        instrument('DOGEUSDT', { lotSizeFilter: undefined, priceFilter: undefined }),
      ]),
    );

    let markets: unknown;
    try {
      markets = await adapter(http).markets();
    } catch (error) {
      expect(error).toBeInstanceOf(VenueUnavailableError);
      const refused = error as VenueUnavailableError;
      expect(refused.venueId).toBe('bybit-spot');
      expect(refused.reason).toBe('malformed');
      expect(refused.message).toMatch(/DOGEUSDT/);
      expect(refused.message).toMatch(/tickSize/);
      expect(refused.message).toMatch(/basePrecision/);
      expect(refused.message).toMatch(/minOrderQty/);
      expect(refused.message).toMatch(/minOrderAmt/);
      expect(refused.message).toMatch(/Refusing the symbol rather than inventing a tick, a lot, or a zero minimum/);
      return;
    }

    expect(markets).not.toEqual([]);
    expect.unreachable('every blank instrument must be refused');
  });

  it('publishes the real tick, base precision, min qty, and min cost', async () => {
    const http = new FakeHttp().queue(
      envelope([
        instrument('BTCUSDT', {
          tickSize: '0.25',
          basePrecision: '0.0001',
          minOrderQty: '0.003',
          minOrderAmt: '10',
        }),
      ]),
    );
    const markets = await adapter(http).markets();

    expect(markets).toHaveLength(1);
    const btc = markets[0]!;
    expect(btc.symbol).toBe('BTC/USDT');
    expect(formatAmount(btc.precision.price)).toBe('0.25');
    expect(formatAmount(btc.precision.amount)).toBe('0.0001');
    expect(formatAmount(btc.limits.minAmount)).toBe('0.003');
    expect(formatAmount(btc.limits.minCost)).toBe('10');
    expect(btc.precision.price).not.toBe(parseAmount('0.00000001'));
    expect(btc.precision.amount).not.toBe(parseAmount('0.00000001'));
    expect(btc.limits.minAmount).not.toBe(0n);
    expect(btc.limits.minCost).not.toBe(0n);
  });
});
