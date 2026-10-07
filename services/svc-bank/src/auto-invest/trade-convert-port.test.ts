/**
 * Unit card — bank.auto-invest ConvertPort HTTP adapter (trade.convert)
 *
 * 1. Promise: DCA convert amounts come from trade.convert; bank invents no mid.
 * 2. Break: quote/execute failure or missing market still returns a fill.
 * 3. Done bar: a buy books execute filled base qty; a sell books execute
 *    outAmount; omitted spot/active, a quote that is not fullyFilled true,
 *    and an execute that is not status filled with remaining 0 refuse
 *    bank.auto_invest_rate_unset (no invented price);
 *    usableTradeConvertUrl rejects empty/non-http.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/auto-invest/**
 * 6. RED first: this suite
 * 7. Collision: #2194 compose / #2202 index affiliate — this file is new
 */
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { assertConvertMarketsListLimit, tradeConvertPort, usableTradeConvertUrl } from './trade-convert-port.js';

const EDGE = 'a-bank-auto-invest-convert-edge-secret-32ch';
const USER = '11111111-1111-4111-8111-111111111111';
/** Explicit owner-published window — 50 is allowed when passed, never as a silent default. */
const MARKETS_LIMIT = 50;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('assertConvertMarketsListLimit', () => {
  it('refuses blank / NaN / 0 / 501 — never invent 50', () => {
    for (const bad of [undefined, Number.NaN, 0, 501, 1.5] as const) {
      expect(() => assertConvertMarketsListLimit(bad)).toThrow(BankError);
    }
    try {
      assertConvertMarketsListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(BankError);
      expect((e as BankError).code).toBe('bank.convert_markets_limit_unset');
      expect((e as BankError).message).not.toMatch(/default 50|50-row/i);
    }
  });

  it('accepts owner-published 50 and 500', () => {
    expect(assertConvertMarketsListLimit(50)).toBe(50);
    expect(assertConvertMarketsListLimit(1)).toBe(1);
    expect(assertConvertMarketsListLimit(500)).toBe(500);
  });
});

describe('usableTradeConvertUrl', () => {
  it('accepts http(s) TRADE_URL and rejects empty / non-http', () => {
    expect(usableTradeConvertUrl('http://svc-trade:4004')).toBe(true);
    expect(usableTradeConvertUrl('https://trade.example')).toBe(true);
    expect(usableTradeConvertUrl('')).toBe(false);
    expect(usableTradeConvertUrl(undefined)).toBe(false);
    expect(usableTradeConvertUrl('not-a-url')).toBe(false);
    expect(usableTradeConvertUrl('ftp://svc-trade:4004')).toBe(false);
  });
});

describe('tradeConvertPort — amounts from trade, never a bank mid', () => {
  it('buy path returns convert execute filled qty (decimal strings on the wire)', async () => {
    const seen: string[] = [];
    const port = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      edgeSecret: EDGE,
      marketsLimit: MARKETS_LIMIT,
      fetchImpl: async (input) => {
        const url = String(input);
        seen.push(url);
        if (url.includes('/api/v1/markets')) {
          return jsonResponse(200, [
            {
              symbol: 'BTC/USDT',
              base: 'BTC',
              quote: 'USDT',
              spot: true,
              active: true,
              limits: { amount: { min: '0.001' } },
            },
          ]);
        }
        if (url.includes('/trpc/convert.quote')) {
          return jsonResponse(200, {
            result: {
              data: {
                symbol: 'BTC/USDT',
                side: 'buy',
                requestedQty: '0.002',
                filledQty: '0.002',
                userNotional: '100',
                avgPrice: '50000',
                fullyFilled: true,
                convertSpreadBps: 10,
                expiresAt: '2026-08-16T12:00:00.000Z',
              },
            },
          });
        }
        if (url.includes('/trpc/convert.execute')) {
          return jsonResponse(200, {
            result: {
              data: {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                filled: '0.002',
                remaining: '0',
                status: 'filled',
              },
            },
          });
        }
        return jsonResponse(404, { error: { message: 'unexpected' } });
      },
    });

    const result = await port.convert({
      userId: USER,
      fromAsset: 'USDT',
      toAsset: 'BTC',
      fromAmount: parseAmount('100'),
      clientConvertId: 'dca-test-1',
    });

    expect(formatAmount(result.toAmount)).toBe('0.002');
    expect(result.ledgerTxId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(seen).toContain(`http://svc-trade:4004/api/v1/markets?limit=${MARKETS_LIMIT}`);
    expect(seen.some((u) => u.includes('/trpc/convert.quote'))).toBe(true);
    expect(seen.some((u) => u.includes('/trpc/convert.execute'))).toBe(true);
  });

  it('refuses by name when convert.quote fails — does not invent a price', async () => {
    const port = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      edgeSecret: EDGE,
      marketsLimit: MARKETS_LIMIT,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/api/v1/markets')) {
          return jsonResponse(200, [
            { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true, limits: { amount: { min: '0.001' } } },
          ]);
        }
        return jsonResponse(400, {
          error: { message: 'insufficient book depth', data: { intafacedCode: 'trade.convert_insufficient_depth' } },
        });
      },
    });

    await expect(
      port.convert({
        userId: USER,
        fromAsset: 'USDT',
        toAsset: 'BTC',
        fromAmount: parseAmount('100'),
        clientConvertId: 'dca-fail-1',
      }),
    ).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when execute fills nothing rather than substituting a ticker mid', async () => {
    const port = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      edgeSecret: EDGE,
      marketsLimit: MARKETS_LIMIT,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/api/v1/markets')) {
          return jsonResponse(200, [
            { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true, limits: { amount: { min: '0.001' } } },
          ]);
        }
        if (url.includes('/trpc/convert.quote')) {
          return jsonResponse(200, {
            result: {
              data: {
                symbol: 'BTC/USDT',
                side: 'buy',
                requestedQty: '0.002',
                filledQty: '0.002',
                userNotional: '100',
                avgPrice: '50000',
                fullyFilled: true,
              },
            },
          });
        }
        return jsonResponse(200, {
          result: { data: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', filled: '0', remaining: '0.002', status: 'cancelled' } },
        });
      },
    });

    await expect(
      port.convert({
        userId: USER,
        fromAsset: 'USDT',
        toAsset: 'BTC',
        fromAmount: parseAmount('100'),
        clientConvertId: 'dca-empty-fill',
      }),
    ).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('omit marketsLimit refuses bank.convert_markets_limit_unset — never calls trade, never invents 50', async () => {
    let fetches = 0;
    const port = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      edgeSecret: EDGE,
      fetchImpl: async () => {
        fetches += 1;
        return jsonResponse(200, [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }]);
      },
    });

    await expect(
      port.convert({
        userId: USER,
        fromAsset: 'USDT',
        toAsset: 'BTC',
        fromAmount: parseAmount('100'),
        clientConvertId: 'dca-limit-unset',
      }),
    ).rejects.toMatchObject({ code: 'bank.convert_markets_limit_unset' });
    expect(fetches).toBe(0);
  });

  it('empty markets listing refuses rate_unset — does not fabricate a pair', async () => {
    const port = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      edgeSecret: EDGE,
      marketsLimit: MARKETS_LIMIT,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/api/v1/markets?limit=')) return jsonResponse(200, []);
        return jsonResponse(404, { error: { message: 'unexpected' } });
      },
    });

    await expect(
      port.convert({
        userId: USER,
        fromAsset: 'USDT',
        toAsset: 'BTC',
        fromAmount: parseAmount('100'),
        clientConvertId: 'dca-empty-markets',
      }),
    ).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('listed pair missing refuses rate_unset — does not invent a convert market', async () => {
    const port = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      edgeSecret: EDGE,
      marketsLimit: MARKETS_LIMIT,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/api/v1/markets?limit=')) {
          return jsonResponse(200, [
            { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', spot: true, active: true, limits: { amount: { min: '0.001' } } },
          ]);
        }
        return jsonResponse(404, { error: { message: 'unexpected' } });
      },
    });

    await expect(
      port.convert({
        userId: USER,
        fromAsset: 'USDT',
        toAsset: 'BTC',
        fromAmount: parseAmount('100'),
        clientConvertId: 'dca-no-pair',
      }),
    ).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });
});

const BUY = {
  userId: USER,
  fromAsset: 'USDT',
  toAsset: 'BTC',
  fromAmount: parseAmount('100'),
  clientConvertId: 'dca-l154-buy',
};

const SELL = {
  userId: USER,
  fromAsset: 'BTC',
  toAsset: 'USDT',
  fromAmount: parseAmount('0.002'),
  clientConvertId: 'dca-l154-sell',
};

const LISTED_SPOT = {
  symbol: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  spot: true,
  active: true,
  limits: { amount: { min: '0.001' } },
};

function quoteWire(overrides: Record<string, unknown> = {}, omit: readonly string[] = []): Record<string, unknown> {
  const quote: Record<string, unknown> = {
    symbol: 'BTC/USDT',
    side: 'buy',
    requestedQty: '0.002',
    filledQty: '0.002',
    userNotional: '100',
    avgPrice: '50000',
    fullyFilled: true,
    ...overrides,
  };
  for (const key of omit) delete quote[key];
  return quote;
}

function executeWire(overrides: Record<string, unknown> = {}, omit: readonly string[] = []): Record<string, unknown> {
  const order: Record<string, unknown> = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    filled: '0.002',
    remaining: '0',
    status: 'filled',
    ...overrides,
  };
  for (const key of omit) delete order[key];
  return order;
}

/** Seam: tradeConvertPort.convert, with fetchImpl standing in for svc-trade. */
function portFrom(markets: unknown, quote: unknown, execute: unknown) {
  return tradeConvertPort({
    baseUrl: 'http://svc-trade:4004',
    edgeSecret: EDGE,
    marketsLimit: MARKETS_LIMIT,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/markets')) return jsonResponse(200, markets);
      if (url.includes('/trpc/convert.quote')) return jsonResponse(200, { result: { data: quote } });
      if (url.includes('/trpc/convert.execute')) return jsonResponse(200, { result: { data: execute } });
      return jsonResponse(404, { error: { message: 'unexpected' } });
    },
  });
}

describe('tradeConvertPort.convert — a listed market is tradable only when spot and active are true', () => {
  it('refuses when spot is omitted, even though the pair matches', async () => {
    const port = portFrom(
      [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, limits: { amount: { min: '0.001' } } }],
      quoteWire(),
      executeWire(),
    );
    await expect(port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when active is omitted, even though the pair matches', async () => {
    const port = portFrom(
      [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, limits: { amount: { min: '0.001' } } }],
      quoteWire(),
      executeWire(),
    );
    await expect(port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when spot is false', async () => {
    const port = portFrom([{ ...LISTED_SPOT, spot: false }], quoteWire(), executeWire());
    await expect(port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when active is false', async () => {
    const port = portFrom([{ ...LISTED_SPOT, active: false }], quoteWire(), executeWire());
    await expect(port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });
});

describe('tradeConvertPort.convert — quote proceeds only when fullyFilled is true', () => {
  it('refuses when fullyFilled is omitted', async () => {
    const port = portFrom([LISTED_SPOT], quoteWire({}, ['fullyFilled']), executeWire());
    await expect(port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when fullyFilled is false', async () => {
    const port = portFrom([LISTED_SPOT], quoteWire({ fullyFilled: false }), executeWire());
    await expect(port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });
});

describe('tradeConvertPort.convert — execute books only a complete fill', () => {
  it('refuses when filled is above zero and remaining is above zero', async () => {
    const port = portFrom([LISTED_SPOT], quoteWire(), executeWire({ filled: '0.002', remaining: '0.001', status: 'filled' }));
    await expect(port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when status is not filled', async () => {
    const port = portFrom([LISTED_SPOT], quoteWire(), executeWire({ filled: '0.002', remaining: '0', status: 'partial' }));
    await expect(port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when status is omitted', async () => {
    const port = portFrom([LISTED_SPOT], quoteWire(), executeWire({}, ['status']));
    await expect(port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when remaining is omitted', async () => {
    const port = portFrom([LISTED_SPOT], quoteWire(), executeWire({}, ['remaining']));
    await expect(port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when remaining is blank', async () => {
    const port = portFrom([LISTED_SPOT], quoteWire(), executeWire({ remaining: '' }));
    await expect(port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('a buy that is spot, active, fully filled, status filled, remaining 0 returns the execute filled base qty', async () => {
    const port = portFrom(
      [LISTED_SPOT],
      quoteWire({ fullyFilled: true }),
      executeWire({ filled: '0.002', remaining: '0.0', status: 'filled', outAmount: '250' }),
    );
    const result = await port.convert(BUY);
    expect(formatAmount(result.toAmount)).toBe('0.002');
    expect(result.ledgerTxId).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  });
});

describe('tradeConvertPort.convert — a sell books the quote asset the fill received', () => {
  it('returns the quote asset parsed from execute outAmount', async () => {
    const port = portFrom(
      [LISTED_SPOT],
      quoteWire({ side: 'sell', userNotional: '100', fullyFilled: true }),
      executeWire({ filled: '0.002', remaining: '0', status: 'filled', outAmount: '99.5' }),
    );
    const result = await port.convert(SELL);
    expect(formatAmount(result.toAmount)).toBe('99.5');
    expect(result.ledgerTxId).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  });

  it('refuses when outAmount is missing', async () => {
    const port = portFrom(
      [LISTED_SPOT],
      quoteWire({ side: 'sell', userNotional: '100' }),
      executeWire({ filled: '0.002', remaining: '0', status: 'filled' }),
    );
    await expect(port.convert(SELL)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when outAmount is blank', async () => {
    const port = portFrom(
      [LISTED_SPOT],
      quoteWire({ side: 'sell', userNotional: '100' }),
      executeWire({ outAmount: '' }),
    );
    await expect(port.convert(SELL)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when outAmount is whitespace', async () => {
    const port = portFrom(
      [LISTED_SPOT],
      quoteWire({ side: 'sell', userNotional: '100' }),
      executeWire({ outAmount: '   ' }),
    );
    await expect(port.convert(SELL)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when outAmount is zero', async () => {
    const port = portFrom(
      [LISTED_SPOT],
      quoteWire({ side: 'sell', userNotional: '100' }),
      executeWire({ outAmount: '0' }),
    );
    await expect(port.convert(SELL)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('refuses when outAmount is negative', async () => {
    const port = portFrom(
      [LISTED_SPOT],
      quoteWire({ side: 'sell', userNotional: '100' }),
      executeWire({ outAmount: '-1' }),
    );
    await expect(port.convert(SELL)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });
});
