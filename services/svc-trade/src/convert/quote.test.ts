import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { parseOwnerIntegerEnv } from '../owner-int-env.js';
import {
  acceptConvertQuote,
  assertFirmConvertQuote,
  buildFirmConvertQuote,
  estimateConvert,
  estimateConvertForSpend,
  presentConvertQuote,
  requireConvertQuoteTtlMs,
  snapToTick,
  type FirmConvertQuote,
} from './quote.js';

const TICK = parseAmount('0.01');
const NOW = new Date('2026-08-26T12:00:00.000Z');

function estimateBuy() {
  return estimateConvert({
    side: 'buy',
    qty: parseAmount('2'),
    levels: [
      ['100', '1'],
      ['110', '1'],
    ],
    convertSpreadBps: 100,
    tickSize: TICK,
  });
}

function firm(overrides: Partial<FirmConvertQuote> = {}): FirmConvertQuote {
  const estimate = estimateBuy();
  const built = buildFirmConvertQuote({
    quoteId: 'q-convert-1',
    userId: 'user-1',
    symbol: 'BTC/USDT',
    marketId: 'm-btc',
    side: 'buy',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    requestedQty: parseAmount('2'),
    estimate,
    convertSpreadBps: 100,
    source: { kind: 'book', symbol: 'BTC/USDT', asOf: NOW.toISOString() },
    now: NOW,
    quoteTtlMs: 15_000,
  });
  return { ...built, ...overrides };
}

describe('parseOwnerIntegerEnv', () => {
  it('maps blank/unset/non-integer to null — never invents 10 or 200', () => {
    expect(parseOwnerIntegerEnv(undefined)).toBeNull();
    expect(parseOwnerIntegerEnv(null)).toBeNull();
    expect(parseOwnerIntegerEnv('')).toBeNull();
    expect(parseOwnerIntegerEnv('  ')).toBeNull();
    expect(parseOwnerIntegerEnv('abc')).toBeNull();
    expect(parseOwnerIntegerEnv('10.5')).toBeNull();
    expect(parseOwnerIntegerEnv('10e1')).toBeNull();
    expect(parseOwnerIntegerEnv('+10')).toBeNull();
  });

  it('accepts a published integer string', () => {
    expect(parseOwnerIntegerEnv('0')).toBe(0);
    expect(parseOwnerIntegerEnv('25')).toBe(25);
    expect(parseOwnerIntegerEnv('150')).toBe(150);
  });
});

describe('estimateConvert', () => {
  it('walks asks for a buy and worsens notional by the convert spread', () => {
    const q = estimateBuy();
    expect(q.filledQty).toBe(parseAmount('2'));
    expect(q.bookNotional).toBe(parseAmount('210'));
    expect(q.userNotional).toBe(parseAmount('212.1'));
    expect(q.fullyFilled).toBe(true);
    expect(q.avgPrice >= parseAmount('105')).toBe(true);
  });

  it('walks bids for a sell and reduces what the user receives', () => {
    const q = estimateConvert({
      side: 'sell',
      qty: parseAmount('1'),
      levels: [['100', '5']],
      convertSpreadBps: 100,
      tickSize: TICK,
    });
    expect(q.bookNotional).toBe(parseAmount('100'));
    expect(q.userNotional).toBe(parseAmount('99'));
    expect(q.avgPrice).toBe(parseAmount('99'));
    expect(q.fullyFilled).toBe(true);
  });

  it('reports partial fill when the book is thin', () => {
    const q = estimateConvert({
      side: 'buy',
      qty: parseAmount('10'),
      levels: [['50', '3']],
      convertSpreadBps: 0,
      tickSize: TICK,
    });
    expect(q.filledQty).toBe(parseAmount('3'));
    expect(q.fullyFilled).toBe(false);
  });

  it('refuses an empty book', () => {
    expect(() =>
      estimateConvert({
        side: 'buy',
        qty: parseAmount('1'),
        levels: [],
        convertSpreadBps: 0,
        tickSize: TICK,
      }),
    ).toThrow(/no liquidity/);
  });

  it('refuses unset/non-integer spread rather than inventing 10', () => {
    for (const convertSpreadBps of [null, undefined, Number.NaN, 10.5]) {
      try {
        estimateConvert({
          side: 'buy',
          qty: parseAmount('1'),
          levels: [['100', '1']],
          convertSpreadBps,
          tickSize: TICK,
        });
        throw new Error(`should have thrown for ${String(convertSpreadBps)}`);
      } catch (err) {
        expect((err as { code: string }).code).toBe('trade.convert_spread_unset');
      }
    }
  });
});

describe('snapToTick', () => {
  it('rounds buys up and sells down onto the tick', () => {
    expect(snapToTick(parseAmount('100.001'), TICK, 'buy')).toBe(parseAmount('100.01'));
    expect(snapToTick(parseAmount('100.001'), TICK, 'sell')).toBe(parseAmount('100'));
  });
});

describe('firm convert quote (M27)', () => {
  it('presents source, expiry, and exact in/out decimal strings', () => {
    const q = firm();
    const wire = presentConvertQuote(q);
    expect(wire.quoteId).toBe('q-convert-1');
    expect(wire.source).toEqual({ kind: 'book', symbol: 'BTC/USDT', asOf: NOW.toISOString() });
    expect(wire.expiresAt).toBe('2026-08-26T12:00:15.000Z');
    expect(wire.inAsset).toBe('USDT');
    expect(wire.outAsset).toBe('BTC');
    expect(wire.inAmount).toBe('212.1');
    expect(wire.outAmount).toBe('2');
  });

  it('refuses missing source / expiry / amounts — never invents a mid', () => {
    expect(() => assertFirmConvertQuote(firm({ expiresAt: '' }))).toThrow(/expiry/);
    expect(() => assertFirmConvertQuote(firm({ source: { kind: 'book', symbol: '', asOf: NOW.toISOString() } }))).toThrow(/source/);
    expect(() => assertFirmConvertQuote(firm({ inAmount: 0n }))).toThrow(/amounts/);
  });

  it('accept binds quoted amounts; expiry and last-look refuse', () => {
    const q = firm();
    const bound = acceptConvertQuote({ quote: q, now: new Date('2026-08-26T12:00:01.000Z') });
    expect(bound.fillNotional).toBe(q.userNotional);
    expect(bound.fillPrice).toBe(q.avgPrice);

    expect(() => acceptConvertQuote({ quote: q, now: new Date('2026-08-26T12:00:16.000Z') })).toThrow(/expired/);
    expect(() => acceptConvertQuote({ quote: q, now: new Date('2026-08-26T12:00:01.000Z'), assertedPrice: parseAmount('1') })).toThrow(
      /trade\.convert_price_moved|not the amount/,
    );
  });

  it('refuses unset/non-integer/non-positive TTL rather than inventing 15000', () => {
    for (const quoteTtlMs of [null, undefined, Number.NaN, 10.5, 0, -1]) {
      try {
        buildFirmConvertQuote({
          quoteId: 'q-ttl-unset',
          userId: 'user-1',
          symbol: 'BTC/USDT',
          marketId: 'm-btc',
          side: 'buy',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          requestedQty: parseAmount('2'),
          estimate: estimateBuy(),
          convertSpreadBps: 100,
          source: { kind: 'book', symbol: 'BTC/USDT', asOf: NOW.toISOString() },
          now: NOW,
          quoteTtlMs,
        });
        throw new Error(`should have thrown for ${String(quoteTtlMs)}`);
      } catch (err) {
        expect((err as { code: string }).code).toBe('trade.convert_quote_ttl_unset');
      }
    }
  });

  it('owner-published 15000 is a legal TTL', () => {
    expect(requireConvertQuoteTtlMs(15_000)).toBe(15_000);
    const q = buildFirmConvertQuote({
      quoteId: 'q-ttl-owner',
      userId: 'user-1',
      symbol: 'BTC/USDT',
      marketId: 'm-btc',
      side: 'buy',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      requestedQty: parseAmount('2'),
      estimate: estimateBuy(),
      convertSpreadBps: 100,
      source: { kind: 'book', symbol: 'BTC/USDT', asOf: NOW.toISOString() },
      now: NOW,
      quoteTtlMs: 15_000,
    });
    expect(q.expiresAt).toBe('2026-08-26T12:00:15.000Z');
  });
});

describe('estimateConvertForSpend — buy by spend (quoteQty)', () => {
  const LOT = parseAmount('0.0001');
  const LEVELS = [
    ['100', '1'],
    ['110.37', '2'],
    ['125.5', '10'],
  ] as const;
  const base = {
    side: 'buy' as const,
    levels: LEVELS,
    convertSpreadBps: 25,
    tickSize: TICK,
    lotSize: LOT,
  };

  it('spends exactly what a base-quantity quote of the result charges, never more than typed', () => {
    const typed = parseAmount('10');
    const r = estimateConvertForSpend({ ...base, quoteQty: typed });
    // book 100, spread 25 bps: 100.25 per unit; 10 / 100.25 = 0.0997506... -> 0.0997 on the 0.0001 lot grid.
    expect(r.qty).toBe(parseAmount('0.0997'));
    expect(r.filledQty).toBe(r.qty);
    expect(r.fullyFilled).toBe(true);
    expect(r.userNotional).toBe(parseAmount('9.994925'));
    expect(r.userNotional <= typed).toBe(true);
    // Same numbers as asking for that base amount directly.
    const direct = estimateConvert({ side: 'buy', qty: r.qty, levels: LEVELS, convertSpreadBps: 25, tickSize: TICK });
    expect(direct).toEqual({
      filledQty: r.filledQty,
      bookNotional: r.bookNotional,
      userNotional: r.userNotional,
      avgPrice: r.avgPrice,
      fullyFilled: true,
    });
  });

  it('is the largest lot count that fits: one more lot would exceed the spend', () => {
    for (const typed of ['1', '10', '99.99', '100.25', '250', '1000.123456789', '1234.5']) {
      for (const bps of [0, 1, 25, 333, 5000]) {
        const quoteQty = parseAmount(typed);
        let r;
        try {
          r = estimateConvertForSpend({ ...base, convertSpreadBps: bps, quoteQty });
        } catch (e) {
          // Only the documented refusals are acceptable.
          expect(['trade.below_min_notional', 'trade.convert_insufficient_depth']).toContain((e as { code: string }).code);
          continue;
        }
        expect(r.qty % LOT).toBe(0n);
        expect(r.userNotional <= quoteQty).toBe(true);
        const one = estimateConvert({ side: 'buy', qty: r.qty, levels: LEVELS, convertSpreadBps: bps, tickSize: TICK });
        expect(one.userNotional).toBe(r.userNotional);
        const next = estimateConvert({ side: 'buy', qty: r.qty + LOT, levels: LEVELS, convertSpreadBps: bps, tickSize: TICK });
        expect(next.userNotional > quoteQty).toBe(true);
      }
    }
  });

  it('crosses book levels and still respects the spend', () => {
    const typed = parseAmount('300');
    const r = estimateConvertForSpend({ ...base, quoteQty: typed });
    expect(r.qty > parseAmount('1')).toBe(true);
    expect(r.userNotional <= typed).toBe(true);
  });

  it('spending exactly the cost of a lot-aligned quantity buys that quantity', () => {
    const exact = estimateConvert({ side: 'buy', qty: parseAmount('0.5'), levels: LEVELS, convertSpreadBps: 25, tickSize: TICK });
    const r = estimateConvertForSpend({ ...base, quoteQty: exact.userNotional });
    expect(r.qty).toBe(parseAmount('0.5'));
    expect(r.userNotional).toBe(exact.userNotional);
  });

  it('spending exactly the whole visible book buys all of it; one wei more is a depth refusal', () => {
    const whole = estimateConvert({ side: 'buy', qty: parseAmount('13'), levels: LEVELS, convertSpreadBps: 25, tickSize: TICK });
    expect(estimateConvertForSpend({ ...base, quoteQty: whole.userNotional }).qty).toBe(parseAmount('13'));
    expect(() => estimateConvertForSpend({ ...base, quoteQty: whole.userNotional + 1n })).toThrow(
      expect.objectContaining({ code: 'trade.convert_insufficient_depth' }),
    );
  });

  it('refuses a spend that does not buy one lot with the existing below-minimum code', () => {
    expect(() => estimateConvertForSpend({ ...base, quoteQty: parseAmount('0.01') })).toThrow(
      expect.objectContaining({ code: 'trade.below_min_notional' }),
    );
  });

  it('refuses sell, non-positive spend, unset spread and empty book without inventing anything', () => {
    expect(() => estimateConvertForSpend({ ...base, side: 'sell', quoteQty: parseAmount('10') })).toThrow(
      expect.objectContaining({ code: 'trade.convert_invalid_qty' }),
    );
    expect(() => estimateConvertForSpend({ ...base, quoteQty: 0n })).toThrow(
      expect.objectContaining({ code: 'trade.convert_invalid_qty' }),
    );
    expect(() => estimateConvertForSpend({ ...base, convertSpreadBps: undefined, quoteQty: parseAmount('10') })).toThrow(
      expect.objectContaining({ code: 'trade.convert_spread_unset' }),
    );
    expect(() => estimateConvertForSpend({ ...base, levels: [], quoteQty: parseAmount('10') })).toThrow(
      expect.objectContaining({ code: 'trade.convert_no_liquidity' }),
    );
  });
});
