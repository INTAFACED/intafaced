import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { readDecimal, readInteger, readLevels, readOptionalDecimal, readSignedDecimal, VenueDecimalError } from './decimal.js';
import { parseUnifiedSymbol, roundToLot, roundToTick, unifiedSymbol } from './market.js';
import { isCrossed, midFromSnapshot, topOfBook } from './book.js';
import { annualisedFundingRate } from './rates.js';
import { assertTradeOnly, requireCredentials, type VenueCredentials } from './adapter.js';
import { VenueCredentialScopeError, VenueCredentialsMissingError } from './errors.js';
import { isRestGrade, isWsGrade, type LatencyMeasurement, type VenueLatencyGrade } from './latency.js';

describe('decimal discipline — the wire refuses what a number cannot carry', () => {
  it('reads a decimal string exactly', () => {
    expect(readDecimal('30000.5', 'v', 'price')).toBe(parseAmount('30000.5'));
    expect(readDecimal('0.000000000000000001', 'v', 'price')).toBe(1n);
  });

  it('REFUSES a JSON number rather than coercing it', () => {
    // This is the whole reason the module exists. A coercion here is a fill
    // that is wrong in the last decimal place and looks perfect in a log.
    expect(() => readDecimal(30000.1, 'binance', 'price')).toThrow(VenueDecimalError);
    expect(() => readDecimal(30000.1, 'binance', 'price')).toThrow(/binance\.price.*JSON number/);
  });

  it('names the venue and the field, so an operator can tell a schema change from an outage', () => {
    try {
      readDecimal(null, 'kraken', 'bids.price');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VenueDecimalError);
      const decimalError = error as VenueDecimalError;
      expect(decimalError.venueId).toBe('kraken');
      expect(decimalError.field).toBe('bids.price');
      expect(decimalError.message).toContain('null');
    }
  });

  it('refuses more than 18 places and refuses a negative where unsigned is required', () => {
    expect(() => readDecimal('1.0000000000000000001', 'v', 'price')).toThrow(VenueDecimalError);
    expect(() => readDecimal('-1', 'v', 'price')).toThrow(VenueDecimalError);
  });

  it('allows a negative only through the signed reader — funding goes negative and the sign is the trade', () => {
    expect(readSignedDecimal('-0.0001', 'v', 'fundingRate')).toBe(parseAmount('-0.0001'));
    expect(() => readSignedDecimal(-0.0001, 'v', 'fundingRate')).toThrow(VenueDecimalError);
  });

  it('passes null and undefined through the optional reader without inventing a zero', () => {
    expect(readOptionalDecimal(undefined, 'v', 'markPrice')).toBeNull();
    expect(readOptionalDecimal(null, 'v', 'markPrice')).toBeNull();
    expect(readOptionalDecimal('1.5', 'v', 'markPrice')).toBe(parseAmount('1.5'));
  });

  describe('readInteger', () => {
    it('accepts an integer from either a number or a digit string', () => {
      expect(readInteger(42, 'v', 'sequence')).toBe(42);
      expect(readInteger('42', 'v', 'sequence')).toBe(42);
    });

    it('refuses a string that Number() would silently turn into a plausible sequence', () => {
      // Number('') === 0 and Number('  7 ') === 7. A sequence of 0 that was
      // really an empty field defeats every gap check downstream.
      expect(() => readInteger('', 'v', 'sequence')).toThrow(VenueDecimalError);
      expect(() => readInteger('  7 ', 'v', 'sequence')).toThrow(VenueDecimalError);
      expect(() => readInteger('7.5', 'v', 'sequence')).toThrow(VenueDecimalError);
    });

    it('refuses a sequence past 2^53 — an approximate sequence cannot be compared', () => {
      expect(() => readInteger('9007199254740993', 'v', 'sequence')).toThrow(/safe integer range/);
    });
  });

  describe('readLevels', () => {
    it('sorts bids down and asks up, whatever order the venue sent', () => {
      const bids = readLevels(
        [
          ['30000', '1'],
          ['30002', '2'],
          ['30001', '3'],
        ],
        'bids',
        'v',
      );
      expect(bids.map(([price]) => formatAmount(price))).toEqual(['30002', '30001', '30000']);

      const asks = readLevels(
        [
          ['30005', '1'],
          ['30003', '2'],
          ['30004', '3'],
        ],
        'asks',
        'v',
      );
      expect(asks.map(([price]) => formatAmount(price))).toEqual(['30003', '30004', '30005']);
    });

    it('drops zero quantities in a snapshot but refuses a non-positive price outright', () => {
      expect(readLevels([['30000', '0']], 'bids', 'v')).toEqual([]);
      expect(() => readLevels([['0', '1']], 'bids', 'v')).toThrow(/non-positive price/);
    });

    it('refuses a level that is not a pair, and a body that is not an array', () => {
      expect(() => readLevels([['30000']], 'bids', 'v')).toThrow(/\[price, quantity\] pair/);
      expect(() => readLevels({}, 'bids', 'v')).toThrow(/not an array/);
    });

    it('refuses a book whose levels are JSON numbers', () => {
      expect(() => readLevels([[30000, 1]], 'bids', 'v')).toThrow(VenueDecimalError);
    });
  });
});

describe('unified instrument', () => {
  it('has exactly one spelling for a symbol', () => {
    expect(unifiedSymbol('btc', 'usdt')).toBe('BTC/USDT');
    expect(unifiedSymbol('btc', 'usd', 'btc')).toBe('BTC/USD:BTC');
  });

  it('round-trips through the parser', () => {
    expect(parseUnifiedSymbol('BTC/USDT')).toEqual({ base: 'BTC', quote: 'USDT', settle: null });
    expect(parseUnifiedSymbol('BTC/USD:BTC')).toEqual({ base: 'BTC', quote: 'USD', settle: 'BTC' });
    expect(parseUnifiedSymbol('BTCUSDT')).toBeNull();
  });

  describe('roundToTick', () => {
    it('rounds a buy toward a cheaper or equal price and a sell toward a higher or equal price', () => {
      const tick = parseAmount('0.5');
      const price = parseAmount('30000.3');
      const buy = roundToTick(price, tick, 'buy');
      const sell = roundToTick(price, tick, 'sell');
      // A buy must not rest above the requested limit. A sell must not rest below it.
      expect(buy <= price).toBe(true);
      expect(sell >= price).toBe(true);
      expect(formatAmount(buy)).toBe('30000');
      expect(formatAmount(sell)).toBe('30000.5');
    });

    it('handles a non-decimal tick, which a decimal-places model cannot express', () => {
      const tick = parseAmount('25');
      const price = parseAmount('4013');
      const buy = roundToTick(price, tick, 'buy');
      const sell = roundToTick(price, tick, 'sell');
      expect(buy <= price).toBe(true);
      expect(sell >= price).toBe(true);
      expect(formatAmount(buy)).toBe('4000');
      expect(formatAmount(sell)).toBe('4025');
    });

    it('leaves an on-tick price alone', () => {
      const tick = parseAmount('0.5');
      const price = parseAmount('30000.5');
      expect(roundToTick(price, tick, 'buy')).toBe(price);
      expect(roundToTick(price, tick, 'sell')).toBe(price);
    });

    it('refuses a non-positive tick instead of returning the price unchanged', () => {
      const price = parseAmount('30000.3');
      expect(() => roundToTick(price, parseAmount('0'), 'buy')).toThrow(/non-positive tick/);
      expect(() => roundToTick(price, parseAmount('-0.5'), 'sell')).toThrow(/non-positive tick/);
    });
  });

  it('rounds a quantity down to the lot, never up — we cannot size beyond authority', () => {
    const lot = parseAmount('0.001');
    expect(formatAmount(roundToLot(parseAmount('1.23456'), lot))).toBe('1.234');
    expect(formatAmount(roundToLot(parseAmount('0.0009'), lot))).toBe('0');
  });
});

describe('book top', () => {
  const level = (price: string, qty: string) => [parseAmount(price), parseAmount(qty)] as const;

  it('reads the top from sorted sides and computes the mid', () => {
    const top = topOfBook([level('30000', '2'), level('29999', '5')], [level('30002', '1'), level('30003', '4')]);
    expect(formatAmount(top.bestBid!)).toBe('30000');
    expect(formatAmount(top.bestAsk!)).toBe('30002');
    expect(formatAmount(top.spread!)).toBe('2');
    expect(formatAmount(top.mid!)).toBe('30001');
  });

  it('returns nulls rather than zeros on a one-sided book — a one-sided book has no spread', () => {
    const top = topOfBook([level('30000', '2')], []);
    expect(top.bestAsk).toBeNull();
    expect(top.spread).toBeNull();
    expect(top.mid).toBeNull();
  });

  it('returns a null mid on an empty book — never zero, never a last-trade', () => {
    const top = topOfBook([], []);
    expect(top.bestBid).toBeNull();
    expect(top.bestAsk).toBeNull();
    expect(top.mid).toBeNull();
    expect(
      midFromSnapshot({
        venueId: 'binance-spot',
        symbol: 'BTC/USDT',
        bids: [],
        asks: [],
        sequence: 1,
        sequenced: true,
        observedAt: new Date(0),
      }),
    ).toBeNull();
    expect(midFromSnapshot(null)).toBeNull();
    expect(midFromSnapshot(undefined)).toBeNull();
  });

  it('detects a crossed book — the symptom of a missed removal', () => {
    expect(isCrossed(topOfBook([level('30003', '1')], [level('30002', '1')]))).toBe(true);
    // Touching counts: bid === ask cannot rest on a real venue either.
    expect(isCrossed(topOfBook([level('30002', '1')], [level('30002', '1')]))).toBe(true);
    expect(isCrossed(topOfBook([level('30001', '1')], [level('30002', '1')]))).toBe(false);
    expect(isCrossed(topOfBook([], []))).toBe(false);
  });
});

describe('funding', () => {
  it('annualises so two venues on different clocks can be compared', () => {
    const eightHourly = annualisedFundingRate({ rate: parseAmount('0.0001'), intervalSeconds: 28_800 });
    // 31_536_000 / 28_800 = 1095 settlements a year.
    expect(formatAmount(eightHourly)).toBe('0.1095');
  });

  it('keeps the sign — the sign is the trade', () => {
    const negative = annualisedFundingRate({ rate: parseAmount('-0.0001'), intervalSeconds: 28_800 });
    expect(formatAmount(negative)).toBe('-0.1095');
  });

  it('refuses a blank or corrupt interval instead of inventing a zero funding rate', () => {
    // Zero on a real clock is a real annualised rate. One settlement a year is
    // the last interval that still annualises to that rate.
    expect(annualisedFundingRate({ rate: 0n, intervalSeconds: 28_800 })).toBe(0n);
    expect(formatAmount(annualisedFundingRate({ rate: parseAmount('0.0001'), intervalSeconds: 31_536_000 }))).toBe(
      '0.0001',
    );

    const rate = parseAmount('0.01');
    const corrupt: unknown[] = [
      undefined,
      null,
      '',
      0,
      -1,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      31_536_001,
    ];
    const outcomes = corrupt.map((intervalSeconds) => {
      try {
        const invented = annualisedFundingRate({ rate, intervalSeconds: intervalSeconds as number });
        return { intervalSeconds, outcome: `returned ${invented.toString()}` };
      } catch (error) {
        const name = error instanceof Error ? error.name : typeof error;
        return { intervalSeconds, outcome: `threw ${name}` };
      }
    });
    expect(outcomes).toEqual(
      corrupt.map((intervalSeconds) => ({ intervalSeconds, outcome: 'threw FundingIntervalError' })),
    );
  });
});

describe('credentials — the loud failure', () => {
  const tradeOnly: VenueCredentials = { venueId: 'v', apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] };

  it('throws a named error when no key is configured, rather than returning a plausible rejection', () => {
    expect(() => requireCredentials('binance', 'placeOrder', null)).toThrow(VenueCredentialsMissingError);
    try {
      requireCredentials('binance', 'placeOrder', undefined);
      expect.unreachable('should have thrown');
    } catch (error) {
      const missing = error as VenueCredentialsMissingError;
      expect(missing.venueId).toBe('binance');
      expect(missing.operation).toBe('placeOrder');
      // The message has to tell the owner what to do, not just that it failed.
      expect(missing.message).toContain('TRADE-ONLY key');
      expect(missing.message).toContain('Venue Vault');
    }
  });

  it('accepts a trade-only key', () => {
    expect(requireCredentials('v', 'placeOrder', tradeOnly)).toBe(tradeOnly);
  });

  it('REFUSES a key that can withdraw, at load time, naming the scopes', () => {
    const dangerous: VenueCredentials = { ...tradeOnly, scopes: ['read', 'trade', 'WITHDRAW'] };
    expect(() => assertTradeOnly(dangerous)).toThrow(VenueCredentialScopeError);
    try {
      assertTradeOnly(dangerous);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as VenueCredentialScopeError).refusedScopes).toEqual(['WITHDRAW']);
    }
  });

  it('refuses a withdrawal-capable key on the use path too, not only at load', () => {
    const dangerous: VenueCredentials = { ...tradeOnly, scopes: ['trade', 'universal-transfer'] };
    expect(() => requireCredentials('v', 'placeOrder', dangerous)).toThrow(VenueCredentialScopeError);
  });

  it('refuses a folded withdrawal scope, a plural transfer, an empty scope list, and a blank scope', () => {
    const universalUnderscore: VenueCredentials = { ...tradeOnly, scopes: ['trade', 'universal_transfer'] };
    const pluralTransfer: VenueCredentials = { ...tradeOnly, scopes: ['trade', 'transfers'] };
    const internalTransfer: VenueCredentials = { ...tradeOnly, scopes: ['internal_transfer'] };
    const emptyScopes: VenueCredentials = { ...tradeOnly, scopes: [] };
    const blankScope: VenueCredentials = { ...tradeOnly, scopes: [''] };
    const whitespaceScope: VenueCredentials = { ...tradeOnly, scopes: ['   '] };
    const trade: VenueCredentials = { ...tradeOnly, scopes: ['trade'] };

    expect(() => requireCredentials('v', 'placeOrder', universalUnderscore)).toThrow(VenueCredentialScopeError);
    expect(() => requireCredentials('v', 'placeOrder', pluralTransfer)).toThrow(VenueCredentialScopeError);
    expect(() => requireCredentials('v', 'placeOrder', internalTransfer)).toThrow(VenueCredentialScopeError);
    expect(() => requireCredentials('v', 'placeOrder', emptyScopes)).toThrow(VenueCredentialScopeError);
    expect(() => requireCredentials('v', 'placeOrder', blankScope)).toThrow(VenueCredentialScopeError);
    expect(() => requireCredentials('v', 'placeOrder', whitespaceScope)).toThrow(VenueCredentialScopeError);
    expect(requireCredentials('v', 'placeOrder', trade)).toBe(trade);
    expect(requireCredentials('v', 'placeOrder', tradeOnly)).toBe(tradeOnly);
  });
});

describe('LatencyMeasurement — closed union of REST and WS handshake', () => {
  const empty = (measurement: LatencyMeasurement): VenueLatencyGrade => ({
    venueId: 'v',
    measurement,
    grade: null,
    samples: 0,
    p50Ms: null,
    p95Ms: null,
    rejectRateBps: null,
    errorRateBps: null,
    staleMs: null,
    provisional: false,
    reasons: ['ungraded'],
  });

  it('names rest-round-trip and ws-round-trip as distinct measurements', () => {
    const rest = empty('rest-round-trip');
    const ws = empty('ws-round-trip');
    expect(isRestGrade(rest)).toBe(true);
    expect(isWsGrade(rest)).toBe(false);
    expect(isWsGrade(ws)).toBe(true);
    expect(isRestGrade(ws)).toBe(false);
    expect(rest.measurement).not.toBe(ws.measurement);
  });

  it('forces a consumer switch to name both — a third member is a compile break', () => {
    const nameOf = (m: LatencyMeasurement): 'rest' | 'ws' => {
      switch (m) {
        case 'rest-round-trip':
          return 'rest';
        case 'ws-round-trip':
          return 'ws';
      }
    };
    expect(nameOf('rest-round-trip')).toBe('rest');
    expect(nameOf('ws-round-trip')).toBe('ws');
  });
});
