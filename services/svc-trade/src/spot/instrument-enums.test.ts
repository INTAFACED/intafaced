import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { assertKnownAssetClass, requireTradingSchedule } from './instrument-enums.js';
import { assertMarketOpen, assertTradable } from './risk.js';
import { TradeError, type Market } from './types.js';

/**
 * D26-P1-T9 — enum authority + closed-venue refuse + additive spot bar.
 * Own file so T6/T7 can edit risk.test.ts without colliding on these proofs.
 */

const BTCUSDT: Market = {
  id: '00000000-0000-4000-8000-000000000001',
  symbol: 'BTC/USDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  kind: 'spot',
  tickSize: amt('0.01'),
  lotSize: amt('0.0001'),
  minQty: amt('0.0001'),
  maxQty: amt('100'),
  minNotional: amt('1'),
  status: 'active',
  makerBps: 10,
  takerBps: 20,
  listedAt: new Date(),
  assetClass: 'crypto',
  schedule: 'crypto-24x7',
  paper: false,
};

const withMarket = (overrides: Partial<Market>): Market => ({ ...BTCUSDT, ...overrides });

describe('instrument enum authority (D26-P1-T9)', () => {
  it('refuses an unknown schedule with permitted keys named — not a TypeError', () => {
    const drifted = withMarket({ schedule: 'lse-equities' as Market['schedule'] });
    expect(() => requireTradingSchedule(drifted)).toThrow(TradeError);
    try {
      requireTradingSchedule(drifted);
    } catch (err) {
      expect(err).toBeInstanceOf(TradeError);
      expect((err as TradeError).code).toBe('trade.unknown_schedule');
      expect((err as TradeError).message).toContain('lse-equities');
      expect((err as TradeError).message).toMatch(/crypto-24x7/);
      expect((err as TradeError).message).toMatch(/fx-global/);
      expect((err as TradeError).message).toMatch(/cme-globex/);
    }
    expect(() => assertMarketOpen(drifted, new Date('2026-01-14T12:00:00Z'))).toThrow(TradeError);
  });

  it('refuses missing schedule rather than reading through it', () => {
    for (const bad of [undefined, null, '']) {
      const market = withMarket({ schedule: bad as Market['schedule'] });
      expect(() => requireTradingSchedule(market)).toThrow(TradeError);
      try {
        requireTradingSchedule(market);
      } catch (err) {
        expect((err as TradeError).code).toBe('trade.unknown_schedule');
      }
    }
  });

  it('refuses an unknown asset_class with the permitted set named', () => {
    const drifted = withMarket({ assetClass: 'equity' as Market['assetClass'] });
    expect(() => assertKnownAssetClass(drifted)).toThrow(TradeError);
    try {
      assertKnownAssetClass(drifted);
    } catch (err) {
      expect((err as TradeError).code).toBe('trade.unknown_asset_class');
      expect((err as TradeError).message).toContain('equity');
      expect((err as TradeError).message).toMatch(/crypto/);
      expect((err as TradeError).message).toMatch(/commodity/);
      expect((err as TradeError).message).toMatch(/forex/);
    }
    expect(() => assertTradable(drifted)).toThrow(TradeError);
  });

  it('additive spot bar — crypto stays open on the FX weekend', () => {
    expect(() => assertMarketOpen(BTCUSDT, new Date('2026-01-10T12:00:00Z'))).not.toThrow();
    expect(() => assertTradable(BTCUSDT)).not.toThrow();
  });
});
