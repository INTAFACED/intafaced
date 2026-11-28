import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { createMarketRouter } from './router.js';
import { MarketError, type VendorService } from './vendor-service.js';
import {
  MARKET_DATA_CEILING,
  MARKET_L3_UNAVAILABLE,
  MARKET_NOT_NATIVE_EXECUTABLE,
  MARKET_REFERENCE_NOT_BOOK,
  describeMarketDataHonesty,
  presentQuote,
  quotePriceSchema,
  requestBook,
  requirePositiveQuotePrice,
  type BookProduct,
  type QuoteKind,
} from './market-data-honesty.js';

const MARKET = 'BTC-USDT';

describe('svc-market market-data honesty (PTX-M06-R06/R09)', () => {
  it('declares L1/L2/index ceiling and never L3', () => {
    const p = describeMarketDataHonesty();
    expect(p.servedCeiling).toEqual(MARKET_DATA_CEILING);
    expect(p.servesL3).toBe(false);
    expect(p.servesQueue).toBe(false);
    expect(p.inventsL3).toBe(false);
    expect(p.indexIsBidAsk).toBe(false);
    expect(p.markIsBidAsk).toBe(false);
    expect(p.impliedIsNativeExecutable).toBe(false);
    expect(p.syntheticIsNativeExecutable).toBe(false);
    expect(p.indicativeIsNativeExecutable).toBe(false);
    expect(p.l3RefuseCode).toBe(MARKET_L3_UNAVAILABLE);
  });

  it.each(['L3', 'queue', 'executable_l3'] as const satisfies readonly BookProduct[])(
    'refuses %s with market.l3_unavailable and invents no orders',
    (product) => {
      try {
        requestBook({ marketId: MARKET, product });
        throw new Error('expected refuse');
      } catch (err) {
        expect(err).toBeInstanceOf(MarketError);
        expect((err as MarketError).code).toBe(MARKET_L3_UNAVAILABLE);
        expect((err as MarketError).detail).toMatchObject({ product, marketId: MARKET });
      }
    },
  );

  it.each(['L1', 'L2'] as const)('returns unserved %s with null sides — not an empty book', (product) => {
    const view = requestBook({ marketId: MARKET, product });
    expect(view.executableNative).toBe(false);
    expect(view.kind).toBe('unserved');
    expect(view.bids).toBeNull();
    expect(view.asks).toBeNull();
    expect(view.orders).toBeNull();
    expect(view.queue).toBeNull();
    expect(view).not.toHaveProperty('levels');
  });

  it.each(['implied', 'synthetic', 'indicative'] as const satisfies readonly QuoteKind[])(
    'refuses %s asked as native executable',
    (kind) => {
      expect(() => presentQuote({ kind, price: '100.5', asNativeExecutable: true })).toThrow(MarketError);
      try {
        presentQuote({ kind, price: '100.5', asNativeExecutable: true });
      } catch (err) {
        expect((err as MarketError).code).toBe(MARKET_NOT_NATIVE_EXECUTABLE);
      }
    },
  );

  it.each(['index', 'mark'] as const)('refuses %s asked as bid/ask', (kind) => {
    try {
      presentQuote({ kind, price: '100.5', asBidAsk: true });
      throw new Error('expected refuse');
    } catch (err) {
      expect((err as MarketError).code).toBe(MARKET_REFERENCE_NOT_BOOK);
    }
  });

  it('index/mark views carry the reference field and never a bid or ask', () => {
    const index = presentQuote({ kind: 'index', price: '30100.25' });
    expect(index.executableNative).toBe(false);
    expect(index.bid).toBeNull();
    expect(index.ask).toBeNull();
    expect(index.index).toBe('30100.25');
    expect(index.mark).toBeNull();

    const mark = presentQuote({ kind: 'mark', price: '30101' });
    expect(mark.executableNative).toBe(false);
    expect(mark.bid).toBeNull();
    expect(mark.ask).toBeNull();
    expect(mark.mark).toBe('30101');
    expect(mark.index).toBeNull();
  });

  it('native_executable kind refuses — this service has no native book', () => {
    try {
      presentQuote({ kind: 'native_executable', price: '1' });
      throw new Error('expected refuse');
    } catch (err) {
      expect((err as MarketError).code).toBe(MARKET_NOT_NATIVE_EXECUTABLE);
    }
  });

  it('implied quote is labelled non-executable with no bid/ask', () => {
    const q = presentQuote({ kind: 'implied', price: '99.5' });
    expect(q.kind).toBe('implied');
    expect(q.executableNative).toBe(false);
    expect(q.bid).toBeNull();
    expect(q.ask).toBeNull();
  });

  it.each([
    ['', 'blank'],
    [' ', 'whitespace'],
    ['   ', 'whitespace run'],
    ['\t', 'tab'],
    [' 1.25', 'leading whitespace'],
    ['1.25 ', 'trailing whitespace'],
    ['abc', 'non-decimal'],
    ['1.2.3', 'non-decimal'],
    ['1e2', 'non-decimal'],
    ['0', 'zero'],
    ['0.0', 'zero'],
    ['0.00', 'zero'],
    ['-0', 'negative zero'],
    ['-1', 'negative'],
    ['-0.01', 'negative'],
  ] as const)('refuses a %s quote price (%s) and does not copy it into index or mark', (price, _label) => {
    for (const kind of ['index', 'mark'] as const) {
      let view: ReturnType<typeof presentQuote> | undefined;
      let err: unknown;
      try {
        view = presentQuote({ kind, price });
      } catch (caught) {
        err = caught;
      }
      expect(view, `${kind} published ${JSON.stringify(price)}`).toBeUndefined();
      expect(err).toBeInstanceOf(MarketError);
      expect((err as MarketError).code).toBe('market.quote_price_invalid');
      expect((err as MarketError).detail?.index).toBeUndefined();
      expect((err as MarketError).detail?.mark).toBeUndefined();
      expect((err as MarketError).detail?.price).toBeUndefined();
    }
  });

  it('presents a positive decimal such as 1.25 with executableNative false', () => {
    const index = presentQuote({ kind: 'index', price: '1.25' });
    expect(index.executableNative).toBe(false);
    expect(index.price).toBe('1.25');
    expect(index.index).toBe('1.25');
    expect(index.mark).toBeNull();
    expect(index.bid).toBeNull();
    expect(index.ask).toBeNull();

    const mark = presentQuote({ kind: 'mark', price: '1.25' });
    expect(mark.executableNative).toBe(false);
    expect(mark.price).toBe('1.25');
    expect(mark.mark).toBe('1.25');
    expect(mark.index).toBeNull();
  });

  it('public quote price schema refuses the same bad strings and keeps 1.25', () => {
    for (const price of ['', ' ', '\t', ' 1.25', 'abc', '0', '0.0', '-1', '-0.01']) {
      const parsed = quotePriceSchema.safeParse(price);
      expect(parsed.success, JSON.stringify(price)).toBe(false);
      if (!parsed.success) {
        expect(parsed.error?.issues.some((issue) => issue.message === 'market.quote_price_invalid')).toBe(true);
      }
    }
    expect(quotePriceSchema.parse('1.25')).toBe('1.25');
  });

  it('quote price uses the decimal-string parser, not a JavaScript number', async () => {
    // A JavaScript number would round these digits; the decimal parser keeps the caller's spelling.
    const exact = '9007199254740993.000000000000000001';
    expect(presentQuote({ kind: 'mark', price: exact }).price).toBe(exact);
    expect(requirePositiveQuotePrice('0.000000000000000001')).toBe('0.000000000000000001');
    for (const bad of ['1e3', '0x10', 'Infinity', 'NaN', '1,5']) {
      expect(() => requirePositiveQuotePrice(bad), bad).toThrow(MarketError);
    }

    // The public door takes the same schema: a bad string refuses before presentQuote, a good one comes back as sent.
    const ctx = createEdgeContext({ secret: 'a-market-quote-test-edge-secret-long', serviceName: 'svc-market' })({
      headers: { 'x-intafaced-region': 'DE' },
      id: 'req-quote',
    });
    const caller = createMarketRouter({} as VendorService).createCaller(ctx);
    expect((await caller.marketData.quote({ kind: 'mark', price: exact })).price).toBe(exact);
    for (const bad of ['', ' 1.25', 'abc', '0', '-1', '1e3']) {
      await expect(caller.marketData.quote({ kind: 'mark', price: bad }), JSON.stringify(bad)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
  });
});
