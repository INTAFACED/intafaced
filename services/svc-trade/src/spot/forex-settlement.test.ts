import { describe, expect, it } from 'vitest';
import { TradeError } from './types.js';
import {
  FOREX_SETTLEMENT_REFUSE_CODE,
  FOREX_SETTLEMENT_SOCKET,
  assertProductionUnsettledAssetClassListing,
  assertSettlementRails,
  forexSettlementStatus,
} from './forex-settlement.js';

describe('forex-settlement (D26-P1-T7)', () => {
  it('settlementStatus is refuse-closed and names the §13 socket + P0-05', () => {
    const s = forexSettlementStatus();
    expect(s.published).toBe(false);
    expect(s.socket).toBe(FOREX_SETTLEMENT_SOCKET);
    expect(s.blockers).toEqual(['settlement_asset_law', 'fiat_settle_rails']);
    expect(s.statusLine).toContain(FOREX_SETTLEMENT_SOCKET);
    expect(s.residual).toMatch(/settlement asset/i);
    expect(s.allowed.productionActiveListing).toBe(false);
    expect(s.allowed.productionPlace).toBe(false);
    expect(s.allowed.paperListing).toBe(true);
  });

  it('refuses production-active forex listing and names the socket', () => {
    expect(() => assertProductionUnsettledAssetClassListing({ assetClass: 'forex', status: 'active', paper: false })).toThrow(TradeError);
    try {
      assertProductionUnsettledAssetClassListing({ assetClass: 'forex', status: 'active', paper: false });
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(TradeError);
      expect((e as TradeError).code).toBe(FOREX_SETTLEMENT_REFUSE_CODE);
      expect((e as TradeError).message).toMatch(/settlement asset/);
    }
  });

  it('allows paper and non-active forex listing (model without open risk)', () => {
    expect(() => assertProductionUnsettledAssetClassListing({ assetClass: 'forex', status: 'active', paper: true })).not.toThrow();
    expect(() => assertProductionUnsettledAssetClassListing({ assetClass: 'forex', status: 'pending', paper: false })).not.toThrow();
    expect(() => assertProductionUnsettledAssetClassListing({ assetClass: 'commodity', status: 'halted', paper: false })).not.toThrow();
    expect(() => assertProductionUnsettledAssetClassListing({ assetClass: 'crypto', status: 'active', paper: false })).not.toThrow();
  });

  it('place-path refuse names socket; paper and crypto pass', () => {
    expect(() => assertSettlementRails({ symbol: 'EUR/USD', assetClass: 'forex', paper: false })).toThrow(TradeError);
    try {
      assertSettlementRails({ symbol: 'EUR/USD', assetClass: 'forex', paper: false });
    } catch (e) {
      expect((e as TradeError).code).toBe(FOREX_SETTLEMENT_REFUSE_CODE);
      expect((e as TradeError).message).toMatch(/cannot be traded yet/);
    }
    expect(() => assertSettlementRails({ symbol: 'EUR/USD', assetClass: 'forex', paper: true })).not.toThrow();
    expect(() => assertSettlementRails({ symbol: 'BTC/USDT', assetClass: 'crypto', paper: false })).not.toThrow();
  });
});
