/**
 * Unit card — dated futures refuse without expiry or owner fixing (M10)
 * 1. Promise: dated listing/place without expiry refuses; perp remains perp;
 *    expiry job never invents last trade / mark as settlement
 * 2. Break: omit expiry on dated, or settle from lastTrade when owner price is blank
 * 3. Done bar: TradeError codes named; settlement source is owner_fixing only
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/dated-futures.ts
 */

import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { TradeError, type Market } from '../spot/types.js';
import { presentCcxtMarket } from '../public-rest.js';
import {
  DATED_FUTURES_EXPIRED,
  DATED_FUTURES_EXPIRY_REQUIRED,
  DATED_FUTURES_FIXING_UNCONFIGURED,
  DATED_FUTURES_PAPER_FIXING_STAMP,
  DATED_FUTURES_SETTLEMENT_PRICE_UNSET,
  DATED_FUTURES_TERMS_INCOMPLETE,
  assertDatedFuturesTradable,
  datedFuturesAccruesFunding,
  resolveDatedFuturesListing,
  resolveDatedFuturesSettlement,
  runDatedFuturesExpiryTick,
} from './dated-futures.js';

const expiry = new Date('2026-12-26T08:00:00.000Z');
const beforeExpiry = new Date('2026-12-25T08:00:00.000Z');
const afterExpiry = new Date('2026-12-26T08:00:01.000Z');

const perp: Pick<Market, 'kind' | 'symbol' | 'futuresContractStyle' | 'futuresExpiryAt' | 'futuresSettlementFixing'> = {
  kind: 'futures',
  symbol: 'BTC/USDT-PERP',
  futuresContractStyle: 'perpetual',
  futuresExpiryAt: null,
  futuresSettlementFixing: null,
};

const datedLive: Market = {
  id: '00000000-0000-4000-8000-000000000099',
  symbol: 'BTC/USDT:USDT-251226',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  kind: 'futures',
  tickSize: amt('0.01'),
  lotSize: amt('0.0001'),
  minQty: amt('0.0001'),
  maxQty: null,
  minNotional: amt('1'),
  status: 'active',
  makerBps: 0,
  takerBps: 0,
  listedAt: new Date('2026-01-01T00:00:00.000Z'),
  assetClass: 'crypto',
  schedule: 'crypto-24x7',
  paper: false,
  futuresContractStyle: 'dated',
  futuresExpiryAt: expiry,
  futuresSettlementFixing: 'owner-dated-fixing',
};

describe('resolveDatedFuturesListing — dated vs perp honesty', () => {
  it('returns null for spot without inventing dated terms', () => {
    expect(
      resolveDatedFuturesListing({
        kind: 'spot',
        settlementFixingConfigured: '',
      }),
    ).toBeNull();
  });

  it('returns null for options without inventing dated terms', () => {
    expect(
      resolveDatedFuturesListing({
        kind: 'options',
        settlementFixingConfigured: 'anything',
      }),
    ).toBeNull();
  });

  it('lists kind=futures without style as a perpetual (perp remains perp)', () => {
    const terms = resolveDatedFuturesListing({
      kind: 'futures',
      settlementFixingConfigured: '',
    });
    expect(terms).toEqual({ style: 'perpetual', expiryAt: null, settlementFixing: null });
  });

  it('does not infer dated from a dated-looking symbol — style is listing terms only', () => {
    const terms = resolveDatedFuturesListing({
      kind: 'futures',
      settlementFixingConfigured: 'owner-dated-fixing',
    });
    expect(terms?.style).toBe('perpetual');
    expect(terms?.expiryAt).toBeNull();
  });

  it('refuses a perpetual that carries an expiry (half-shape)', () => {
    try {
      resolveDatedFuturesListing({
        kind: 'futures',
        futuresContractStyle: 'perpetual',
        expiryAt: expiry,
        settlementFixingConfigured: 'owner-dated-fixing',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TradeError);
      expect((err as TradeError).code).toBe(DATED_FUTURES_TERMS_INCOMPLETE);
    }
  });

  it('refuses expiry on a spot listing', () => {
    try {
      resolveDatedFuturesListing({
        kind: 'spot',
        expiryAt: expiry,
        settlementFixingConfigured: '',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(DATED_FUTURES_TERMS_INCOMPLETE);
    }
  });

  it('refuses dated listing without expiry rather than behaving as a perp', () => {
    try {
      resolveDatedFuturesListing({
        kind: 'futures',
        futuresContractStyle: 'dated',
        settlementFixingConfigured: 'owner-dated-fixing',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TradeError);
      expect((err as TradeError).code).toBe(DATED_FUTURES_EXPIRY_REQUIRED);
      expect((err as Error).message).toMatch(/expiry/i);
      expect((err as Error).message).toMatch(/perp/i);
    }
  });

  it('refuses live dated listing when TRADE_FUTURES_SETTLEMENT_FIXING is empty', () => {
    try {
      resolveDatedFuturesListing({
        kind: 'futures',
        futuresContractStyle: 'dated',
        expiryAt: expiry,
        settlementFixingConfigured: '',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(DATED_FUTURES_FIXING_UNCONFIGURED);
      expect((err as Error).message).toContain('TRADE_FUTURES_SETTLEMENT_FIXING');
      expect((err as Error).message).toMatch(/last trade/i);
    }
  });

  it('refuses whitespace-only fixing on live dated listing', () => {
    try {
      resolveDatedFuturesListing({
        kind: 'futures',
        futuresContractStyle: 'dated',
        expiryAt: expiry,
        settlementFixingConfigured: '  \n\t',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(DATED_FUTURES_FIXING_UNCONFIGURED);
    }
  });

  it('lists complete live dated terms when expiry + owner fixing are set', () => {
    const terms = resolveDatedFuturesListing({
      kind: 'futures',
      futuresContractStyle: 'dated',
      expiryAt: expiry,
      settlementFixingConfigured: 'owner-dated-fixing',
    });
    expect(terms).toEqual({
      style: 'dated',
      expiryAt: expiry,
      settlementFixing: 'owner-dated-fixing',
    });
  });

  it('paper dated listing stamps paper fixing when env is empty', () => {
    const terms = resolveDatedFuturesListing({
      kind: 'futures',
      futuresContractStyle: 'dated',
      expiryAt: expiry,
      settlementFixingConfigured: '',
      paper: true,
    });
    expect(terms?.style).toBe('dated');
    expect(terms?.settlementFixing).toBe(DATED_FUTURES_PAPER_FIXING_STAMP);
    expect(terms?.expiryAt).toEqual(expiry);
  });
});

describe('assertDatedFuturesTradable — place/open hitch', () => {
  it('lets a perpetual through (perp remains perp)', () => {
    expect(() => assertDatedFuturesTradable(perp, { now: afterExpiry })).not.toThrow();
  });

  it('lets spot through', () => {
    expect(() =>
      assertDatedFuturesTradable({
        kind: 'spot',
        symbol: 'BTC/USDT',
        futuresContractStyle: null,
        futuresExpiryAt: null,
        futuresSettlementFixing: null,
      }),
    ).not.toThrow();
  });

  it('refuses dated without expiry', () => {
    try {
      assertDatedFuturesTradable({
        kind: 'futures',
        symbol: 'BTC/USDT:USDT-251226',
        futuresContractStyle: 'dated',
        futuresExpiryAt: null,
        futuresSettlementFixing: 'owner-dated-fixing',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(DATED_FUTURES_EXPIRY_REQUIRED);
    }
  });

  it('refuses dated without owner fixing stamp', () => {
    try {
      assertDatedFuturesTradable({
        kind: 'futures',
        symbol: 'BTC/USDT:USDT-251226',
        futuresContractStyle: 'dated',
        futuresExpiryAt: expiry,
        futuresSettlementFixing: '  ',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(DATED_FUTURES_FIXING_UNCONFIGURED);
    }
  });

  it('refuses place after expiry — not a perpetual', () => {
    try {
      assertDatedFuturesTradable(
        {
          kind: 'futures',
          symbol: 'BTC/USDT:USDT-251226',
          futuresContractStyle: 'dated',
          futuresExpiryAt: expiry,
          futuresSettlementFixing: 'owner-dated-fixing',
        },
        { now: afterExpiry },
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TradeError).code).toBe(DATED_FUTURES_EXPIRED);
    }
  });

  it('allows dated place before expiry', () => {
    expect(() =>
      assertDatedFuturesTradable(
        {
          kind: 'futures',
          symbol: 'BTC/USDT:USDT-251226',
          futuresContractStyle: 'dated',
          futuresExpiryAt: expiry,
          futuresSettlementFixing: 'owner-dated-fixing',
        },
        { now: beforeExpiry },
      ),
    ).not.toThrow();
  });
});

describe('expiry settlement — never invent last trade or mark', () => {
  it('skips perpetuals', () => {
    expect(
      resolveDatedFuturesSettlement({
        style: 'perpetual',
        expiryAt: null,
        now: afterExpiry,
        ownerSettlementPrice: '100.00',
      }),
    ).toEqual({ status: 'skipped', reason: 'not_dated' });
  });

  it('skips dated contracts that have not expired', () => {
    expect(
      resolveDatedFuturesSettlement({
        style: 'dated',
        expiryAt: expiry,
        now: beforeExpiry,
        ownerSettlementPrice: '100.00',
      }),
    ).toEqual({ status: 'skipped', reason: 'not_expired' });
  });

  it('refuses blank owner settlement even when last trade and mark are present', () => {
    const result = runDatedFuturesExpiryTick({
      style: 'dated',
      expiryAt: expiry,
      now: afterExpiry,
      ownerSettlementPrice: '',
      lastTradePrice: '99999.00',
      markPrice: '88888.00',
    });
    expect(result).toEqual({
      status: 'refused',
      reason: 'settlement_price_unset',
      code: DATED_FUTURES_SETTLEMENT_PRICE_UNSET,
    });
  });

  it('refuses whitespace / zero / invalid owner settlement price', () => {
    for (const ownerSettlementPrice of ['  ', '0', '-1', 'not-a-decimal']) {
      const result = resolveDatedFuturesSettlement({
        style: 'dated',
        expiryAt: expiry,
        now: afterExpiry,
        ownerSettlementPrice,
        lastTradePrice: '50000',
      });
      expect(result.status).toBe('refused');
      if (result.status === 'refused') {
        expect(result.code).toBe(DATED_FUTURES_SETTLEMENT_PRICE_UNSET);
      }
    }
  });

  it('accepts owner decimal-string fixing and does not copy last trade', () => {
    const result = resolveDatedFuturesSettlement({
      style: 'dated',
      expiryAt: expiry,
      now: afterExpiry,
      ownerSettlementPrice: '101234.567890123456',
      lastTradePrice: '1',
      markPrice: '2',
    });
    expect(result).toEqual({
      status: 'ready',
      settlementPrice: '101234.567890123456',
      source: 'owner_fixing',
    });
  });

  it('expiry job never assigns lastTrade or mark as settlement', () => {
    // With last trade and mark both present, a blank or unusable owner fixing refuses: neither price stands in.
    for (const ownerSettlementPrice of [null, undefined, '', '   ', 'abc', '0', '-1']) {
      for (const run of [resolveDatedFuturesSettlement, runDatedFuturesExpiryTick]) {
        expect(
          run({ style: 'dated', expiryAt: expiry, now: afterExpiry, ownerSettlementPrice, lastTradePrice: '100', markPrice: '101' }),
          String(ownerSettlementPrice),
        ).toEqual({ status: 'refused', reason: 'settlement_price_unset', code: DATED_FUTURES_SETTLEMENT_PRICE_UNSET });
      }
    }
    // A named fixing settles at the fixing alone, whatever last trade and mark say.
    for (const [lastTradePrice, markPrice] of [
      ['100', '101'],
      [null, null],
      ['99999', '1'],
    ] as const) {
      expect(
        runDatedFuturesExpiryTick({
          style: 'dated',
          expiryAt: expiry,
          now: afterExpiry,
          ownerSettlementPrice: '100.5',
          lastTradePrice,
          markPrice,
        }),
      ).toEqual({ status: 'ready', settlementPrice: '100.5', source: 'owner_fixing' });
    }
  });

  it('dated contracts do not accrue perpetual funding', () => {
    expect(datedFuturesAccruesFunding('dated')).toBe(false);
    expect(datedFuturesAccruesFunding('perpetual')).toBe(true);
    expect(datedFuturesAccruesFunding(null)).toBe(false);
  });
});

describe('CCXT listing — dated is future, perp is swap; expiry is listed not invented', () => {
  it('presents a perpetual as swap with null expiry', () => {
    const presented = presentCcxtMarket({ ...datedLive, futuresContractStyle: 'perpetual', futuresExpiryAt: null });
    expect(presented.type).toBe('swap');
    expect(presented.swap).toBe(true);
    expect(presented.future).toBe(false);
    expect(presented.expiry).toBeNull();
    expect(presented.expiryDatetime).toBeNull();
  });

  it('presents a dated listing as future with the listed expiry', () => {
    const presented = presentCcxtMarket(datedLive);
    expect(presented.type).toBe('future');
    expect(presented.swap).toBe(false);
    expect(presented.future).toBe(true);
    expect(presented.expiry).toBe(expiry.getTime());
    expect(presented.expiryDatetime).toBe(expiry.toISOString());
  });
});
