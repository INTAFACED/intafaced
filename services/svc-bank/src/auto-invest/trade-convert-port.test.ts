/**
 * Unit card — bank.auto-invest ConvertPort HTTP adapter (trade.convert)
 *
 * 1. Promise: DCA convert amounts come from trade.convert; bank invents no mid.
 * 2. Break: quote/execute failure or missing market still returns a fill.
 * 3. Done bar: a buy books execute filled base qty; a sell books execute
 *    outAmount; omitted spot/active, a quote that is not fullyFilled true,
 *    and an execute that is not status filled with remaining 0 refuse
 *    bank.auto_invest_rate_unset (no invented price);
 *    a missing or blank limits.amount.min refuses the same code and is not
 *    quoted as an invented 0.00000001 probe; before buy execute the live
 *    quote notional must be a positive scaled amount no greater than
 *    fromAmount;
 *    usableTradeConvertUrl rejects empty/non-http.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/auto-invest/**
 * 6. RED first: this suite
 * 7. Collision: #2194 compose / #2202 index affiliate — this file is new
 */
import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { assertConvertMarketsListLimit, tradeConvertPort, usableTradeConvertUrl } from './trade-convert-port.js';

const SERVICE = 'a-bank-auto-invest-convert-service-secret-32';
const INSTRUCTION = '99999999-9999-4999-8999-999999999999';
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
      serviceSecret: SERVICE,
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
        if (url.includes('/trpc/standing.quote')) {
          return jsonResponse(200, {
            result: {
              data: {
                quoteId: 'q-1',
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
        if (url.includes('/trpc/standing.execute')) {
          return jsonResponse(200, {
            result: {
              data: {
                quoteId: 'q-1',
                fillId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                inAmount: '100',
                outAmount: '0.002',
              },
            },
          });
        }
        return jsonResponse(404, { error: { message: 'unexpected' } });
      },
    });

    const result = await port.convert({
      userId: USER,
      instructionId: INSTRUCTION,
      fromAsset: 'USDT',
      toAsset: 'BTC',
      fromAmount: parseAmount('100'),
      clientConvertId: 'dca-test-1',
    });

    expect(formatAmount(result.toAmount)).toBe('0.002');
    expect(result.ledgerTxId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(seen).toContain(`http://svc-trade:4004/api/v1/markets?limit=${MARKETS_LIMIT}`);
    expect(seen.some((u) => u.includes('/trpc/standing.quote'))).toBe(true);
    expect(seen.some((u) => u.includes('/trpc/standing.execute'))).toBe(true);
  });

  it('refuses by name when convert.quote fails — does not invent a price', async () => {
    const port = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      serviceSecret: SERVICE,
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
        instructionId: INSTRUCTION,
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
      serviceSecret: SERVICE,
      marketsLimit: MARKETS_LIMIT,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/api/v1/markets')) {
          return jsonResponse(200, [
            { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true, limits: { amount: { min: '0.001' } } },
          ]);
        }
        if (url.includes('/trpc/standing.quote')) {
          return jsonResponse(200, {
            result: {
              data: {
                quoteId: 'q-1',
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
          result: { data: { quoteId: 'q-1', fillId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', inAmount: '0', outAmount: '0' } },
        });
      },
    });

    await expect(
      port.convert({
        userId: USER,
        instructionId: INSTRUCTION,
        fromAsset: 'USDT',
        toAsset: 'BTC',
        fromAmount: parseAmount('100'),
        clientConvertId: 'dca-empty-fill',
      }),
    ).rejects.toMatchObject({ name: 'ConvertOutcomeUnknown' });
  });

  it('omit marketsLimit refuses bank.convert_markets_limit_unset — never calls trade, never invents 50', async () => {
    let fetches = 0;
    const port = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      serviceSecret: SERVICE,
      fetchImpl: async () => {
        fetches += 1;
        return jsonResponse(200, [{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }]);
      },
    });

    await expect(
      port.convert({
        userId: USER,
        instructionId: INSTRUCTION,
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
      serviceSecret: SERVICE,
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
        instructionId: INSTRUCTION,
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
      serviceSecret: SERVICE,
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
        instructionId: INSTRUCTION,
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
  instructionId: INSTRUCTION,
  fromAsset: 'USDT',
  toAsset: 'BTC',
  fromAmount: parseAmount('100'),
  clientConvertId: 'dca-l154-buy',
};

const SELL = {
  userId: USER,
  instructionId: INSTRUCTION,
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
    quoteId: 'q-1',
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
    quoteId: 'q-1',
    fillId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    inAmount: '100',
    outAmount: '0.002',
    ...overrides,
  };
  for (const key of omit) delete order[key];
  return order;
}

/** Seam: tradeConvertPort.convert, with fetchImpl standing in for svc-trade. */
function portFrom(markets: unknown, quote: unknown, execute: unknown) {
  return tradeConvertPort({
    baseUrl: 'http://svc-trade:4004',
    serviceSecret: SERVICE,
    marketsLimit: MARKETS_LIMIT,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/markets')) return jsonResponse(200, markets);
      if (url.includes('/trpc/standing.quote')) return jsonResponse(200, { result: { data: quote } });
      if (url.includes('/trpc/standing.execute')) return jsonResponse(200, { result: { data: execute } });
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

describe('tradeConvertPort.convert — after execute is sent, a bad answer is an unknown outcome, never a refusal', () => {
  const unknown = { name: 'ConvertOutcomeUnknown' };

  it('a missing fillId, unreadable or non-positive amount, or overspend is unknown (run stays pending)', async () => {
    const bad: Array<[Record<string, unknown>, string[]]> = [
      [{}, ['fillId']],
      [{}, ['outAmount']],
      [{}, ['inAmount']],
      [{ outAmount: '' }, []],
      [{ outAmount: '0' }, []],
      [{ outAmount: '-1' }, []],
      [{ inAmount: '100.01' }, []],
    ];
    for (const [over, omit] of bad) {
      const port = portFrom([LISTED_SPOT], quoteWire(), executeWire(over, omit));
      const err = await port.convert(BUY).catch((e: unknown) => e);
      expect(err).toMatchObject(unknown);
      expect(err).not.toBeInstanceOf(BankError);
    }
  });

  it('a sell that settled more than fromAmount is unknown', async () => {
    const port = portFrom([LISTED_SPOT], quoteWire({ side: 'sell' }), executeWire({ inAmount: '0.003', outAmount: '99.5' }));
    await expect(port.convert(SELL)).rejects.toMatchObject(unknown);
  });

  it('a timeout, network error, 5xx or untyped 4xx on execute is unknown; a typed refusal is definite', async () => {
    const run = (execute: () => Promise<Response>) =>
      tradeConvertPort({
        baseUrl: 'http://svc-trade:4004',
        serviceSecret: SERVICE,
        marketsLimit: MARKETS_LIMIT,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes('/api/v1/markets')) return jsonResponse(200, [LISTED_SPOT]);
          if (url.includes('/trpc/standing.quote')) return jsonResponse(200, { result: { data: quoteWire() } });
          return execute();
        },
      }).convert(BUY);
    await expect(run(async () => Promise.reject(new Error('socket hang up')))).rejects.toMatchObject(unknown);
    await expect(run(async () => jsonResponse(502, { error: { message: 'bad gateway' } }))).rejects.toMatchObject(unknown);
    await expect(run(async () => jsonResponse(400, { error: { message: 'nope' } }))).rejects.toMatchObject(unknown);
    await expect(run(async () => new Response('<html>bad gateway</html>', { status: 200 }))).rejects.toMatchObject(unknown);
    await expect(run(async () => new Response('{"result":', { status: 200 }))).rejects.toMatchObject(unknown);
    await expect(
      run(async () => jsonResponse(200, { error: { message: 'x', data: { intafacedCode: 'trade.convert_quote_expired' } } })),
    ).rejects.toMatchObject(unknown);
    await expect(
      run(async () => jsonResponse(409, { error: { message: 'x', data: { intafacedCode: 'trade.convert_quote_expired' } } })),
    ).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('sends maxAvgPrice equal to the live quote avgPrice', async () => {
    let body: Record<string, unknown> = {};
    const port = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      serviceSecret: SERVICE,
      marketsLimit: MARKETS_LIMIT,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes('/api/v1/markets')) return jsonResponse(200, [LISTED_SPOT]);
        if (url.includes('/trpc/standing.quote')) return jsonResponse(200, { result: { data: quoteWire() } });
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(200, { result: { data: executeWire() } });
      },
    });
    await port.convert(BUY);
    expect(body.maxAvgPrice).toBe('50000');
  });

  it('a buy returns the settled base qty and the fill id', async () => {
    const port = portFrom([LISTED_SPOT], quoteWire({ fullyFilled: true }), executeWire({ outAmount: '0.002' }));
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
      executeWire({ inAmount: '0.002', outAmount: '99.5' }),
    );
    const result = await port.convert(SELL);
    expect(formatAmount(result.toAmount)).toBe('99.5');
    expect(result.ledgerTxId).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  });

  it('refuses when outAmount is missing', async () => {
    const port = portFrom([LISTED_SPOT], quoteWire({ side: 'sell', userNotional: '100' }), executeWire({}, ['outAmount']));
    await expect(port.convert(SELL)).rejects.toMatchObject({ name: 'ConvertOutcomeUnknown' });
  });

  it('refuses when outAmount is blank', async () => {
    const port = portFrom(
      [LISTED_SPOT],
      quoteWire({ side: 'sell', userNotional: '100' }),
      executeWire({ inAmount: '0.002', outAmount: '' }),
    );
    await expect(port.convert(SELL)).rejects.toMatchObject({ name: 'ConvertOutcomeUnknown' });
  });

  it('refuses when outAmount is whitespace', async () => {
    const port = portFrom(
      [LISTED_SPOT],
      quoteWire({ side: 'sell', userNotional: '100' }),
      executeWire({ inAmount: '0.002', outAmount: '   ' }),
    );
    await expect(port.convert(SELL)).rejects.toMatchObject({ name: 'ConvertOutcomeUnknown' });
  });

  it('refuses when outAmount is zero', async () => {
    const port = portFrom(
      [LISTED_SPOT],
      quoteWire({ side: 'sell', userNotional: '100' }),
      executeWire({ inAmount: '0.002', outAmount: '0' }),
    );
    await expect(port.convert(SELL)).rejects.toMatchObject({ name: 'ConvertOutcomeUnknown' });
  });

  it('refuses when outAmount is negative', async () => {
    const port = portFrom(
      [LISTED_SPOT],
      quoteWire({ side: 'sell', userNotional: '100' }),
      executeWire({ inAmount: '0.002', outAmount: '-1' }),
    );
    await expect(port.convert(SELL)).rejects.toMatchObject({ name: 'ConvertOutcomeUnknown' });
  });
});

function quoteQtyFromBody(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body ?? '{}')) as { qty?: unknown };
  return typeof body.qty === 'string' ? body.qty : '';
}

/** Records quote quantities and execute calls at the convert port seam. */
function watchingPort(markets: unknown, quoteFor: (call: number) => unknown) {
  const quotes: string[] = [];
  const executes: string[] = [];
  const port = tradeConvertPort({
    baseUrl: 'http://svc-trade:4004',
    serviceSecret: SERVICE,
    marketsLimit: MARKETS_LIMIT,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/markets')) return jsonResponse(200, markets);
      if (url.includes('/trpc/standing.quote')) {
        quotes.push(quoteQtyFromBody(init));
        return jsonResponse(200, { result: { data: quoteFor(quotes.length) } });
      }
      if (url.includes('/trpc/standing.execute')) {
        executes.push(url);
        return jsonResponse(200, { result: { data: executeWire() } });
      }
      return jsonResponse(404, { error: { message: 'unexpected' } });
    },
  });
  return { port, quotes, executes };
}

const SPOT_NO_LIMITS = {
  symbol: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  spot: true,
  active: true,
};

describe('tradeConvertPort.convert — a missing or blank minimum is refused', () => {
  it('refuses a missing limits.amount.min and does not quote 0.00000001', async () => {
    const seen = watchingPort([SPOT_NO_LIMITS], () => quoteWire());
    await expect(seen.port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
    expect(seen.quotes).toEqual([]);
    expect(seen.quotes).not.toContain('0.00000001');
    expect(seen.executes).toEqual([]);
  });

  it('refuses a blank limits.amount.min and does not quote 0.00000001', async () => {
    for (const min of ['', '   ', null]) {
      const seen = watchingPort([{ ...SPOT_NO_LIMITS, limits: { amount: { min } } }], () => quoteWire());
      await expect(seen.port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
      expect(seen.quotes).not.toContain('0.00000001');
      expect(seen.executes).toEqual([]);
    }
  });

  it('refuses a non-positive published minimum and does not invent a probe quantity', async () => {
    for (const min of ['0', '-0.001']) {
      const seen = watchingPort([{ ...SPOT_NO_LIMITS, limits: { amount: { min } } }], () => quoteWire());
      await expect(seen.port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
      expect(seen.quotes).not.toContain('0.00000001');
      expect(seen.executes).toEqual([]);
    }
  });

  it('refuses a sell when limits.amount.min is blank', async () => {
    const seen = watchingPort([{ ...SPOT_NO_LIMITS, limits: { amount: { min: '' } } }], () =>
      quoteWire({ side: 'sell', userNotional: '100' }),
    );
    await expect(seen.port.convert(SELL)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
    expect(seen.quotes).not.toContain('0.00000001');
    expect(seen.executes).toEqual([]);
  });

  it('probes a buy with the published positive minimum', async () => {
    const seen = watchingPort([LISTED_SPOT], () => quoteWire({ userNotional: '100' }));
    const result = await seen.port.convert(BUY);
    expect(seen.quotes[0]).toBe('0.001');
    expect(seen.quotes).not.toContain('0.00000001');
    expect(formatAmount(result.toAmount)).toBe('0.002');
    expect(seen.executes).toHaveLength(1);
  });

  it('probes a buy with 0.00000001 only when the market published that minimum', async () => {
    const seen = watchingPort([{ ...LISTED_SPOT, limits: { amount: { min: '0.00000001' } } }], () => quoteWire({ userNotional: '100' }));
    const result = await seen.port.convert(BUY);
    expect(seen.quotes[0]).toBe('0.00000001');
    expect(formatAmount(result.toAmount)).toBe('0.002');
  });
});

describe('tradeConvertPort.convert — buy execute requires the live quote notional inside fromAmount', () => {
  function buyWithLiveNotional(userNotional: unknown) {
    return watchingPort([LISTED_SPOT], (call) => (call === 1 ? quoteWire() : quoteWire({ userNotional })));
  }

  it('refuses when the live quote notional is above fromAmount and does not execute', async () => {
    const seen = buyWithLiveNotional('101');
    await expect(seen.port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
    expect(seen.executes).toEqual([]);
  });

  it('refuses when the live quote notional is zero and does not execute', async () => {
    const seen = buyWithLiveNotional('0');
    await expect(seen.port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
    expect(seen.executes).toEqual([]);
  });

  it('refuses when the live quote notional is blank and does not execute', async () => {
    for (const userNotional of ['', '   ']) {
      const seen = buyWithLiveNotional(userNotional);
      await expect(seen.port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
      expect(seen.executes).toEqual([]);
    }
  });

  it('refuses when the live quote notional is negative and does not execute', async () => {
    const seen = buyWithLiveNotional('-1');
    await expect(seen.port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
    expect(seen.executes).toEqual([]);
  });

  it('refuses when the live quote notional does not parse and does not execute', async () => {
    const seen = buyWithLiveNotional('not-a-notional');
    await expect(seen.port.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
    expect(seen.executes).toEqual([]);
  });

  it('executes a buy when the live quote notional is positive and below fromAmount', async () => {
    const seen = buyWithLiveNotional('99.5');
    const result = await seen.port.convert(BUY);
    expect(formatAmount(result.toAmount)).toBe('0.002');
    expect(seen.executes).toHaveLength(1);
  });
});

describe('tradeConvertPort.convert — a standing instruction, not an interactive customer', () => {
  it('posts the body-bound service call for svc-bank with the user and instruction in the body and no principal', async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const port = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      serviceSecret: SERVICE,
      marketsLimit: MARKETS_LIMIT,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes('/api/v1/markets')) return jsonResponse(200, [LISTED_SPOT]);
        calls.push({
          url,
          method: String(init?.method),
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        if (url.includes('/trpc/standing.quote')) return jsonResponse(200, { result: { data: quoteWire() } });
        return jsonResponse(200, { result: { data: executeWire() } });
      },
    });
    await port.convert(BUY);
    const paths = calls.map((c) => new URL(c.url).pathname);
    expect(paths).toEqual(['/trpc/standing.quote', '/trpc/standing.quote', '/trpc/standing.execute']);
    for (const call of calls) {
      expect(call.method).toBe('POST');
      expect(call.body).toMatchObject({ userId: USER, instructionId: INSTRUCTION });
      expect(call.headers['x-intafaced-service']).toBe('svc-bank');
      expect(Object.keys(call.headers).filter((h) => /principal|edge-sig/i.test(h))).toEqual([]);
      const expected = serviceAuthHeadersForBody('svc-bank', SERVICE, JSON.stringify(call.body), {
        now: new Date(Number(call.headers['x-intafaced-service-ts']) * 1000),
      });
      expect(call.headers['x-intafaced-service-sig']).toBe(expected['x-intafaced-service-sig']);
    }
    expect(calls[2]!.body).toMatchObject({ quoteId: 'q-1', symbol: 'BTC/USDT', side: 'buy', clientConvertId: 'dca-l154-buy' });
  });

  it('refuses a trade door that is off (trade.standing_instruction_disabled) as rate unset', async () => {
    const off = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      serviceSecret: SERVICE,
      marketsLimit: MARKETS_LIMIT,
      fetchImpl: async (input) =>
        String(input).includes('/api/v1/markets')
          ? jsonResponse(200, [LISTED_SPOT])
          : jsonResponse(403, { error: { message: 'off', data: { intafacedCode: 'trade.standing_instruction_disabled' } } }),
    });
    await expect(off.convert(BUY)).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });
});
