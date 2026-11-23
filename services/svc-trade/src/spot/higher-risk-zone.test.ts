import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { assertZoneOrder } from './risk.js';
import { TradeError } from './types.js';
import { fakeMarket, presentCcxtMarket } from '../public-rest.js';

// J-cex-spot-14 #7 (SP-markets-data-02): a higher-risk zone market is flagged, capped and disclosed. It takes limit
// orders only, each under its owner cap; with the cap unset it takes none.
describe('higher-risk zone', () => {
  const zoned = { symbol: 'TRSK/USDC', quoteAsset: 'USDC', zone: 'higher_risk' as const, zoneOrderCap: parseAmount('100') };
  const refusal = (type: string, price: string | null, qty: string, m: Parameters<typeof assertZoneOrder>[0] = zoned) => {
    try {
      assertZoneOrder(m, { type, price: price === null ? null : parseAmount(price), qty: parseAmount(qty) });
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(TradeError);
      return (error as TradeError).code;
    }
  };

  it('refuses a market order and either stop with the zone reason, and takes a limit under the cap', () => {
    expect(refusal('market', null, '1')).toBe('trade.higher_risk_zone');
    expect(refusal('stop', null, '1')).toBe('trade.higher_risk_zone');
    expect(refusal('stop_limit', '1', '1')).toBe('trade.higher_risk_zone');
    expect(refusal('limit', null, '1')).toBe('trade.higher_risk_zone');
    expect(refusal('limit', '1', '1')).toBeNull();
  });

  it('takes a limit worth exactly the cap and refuses one worth a unit more', () => {
    expect(refusal('limit', '10', '10')).toBeNull();
    expect(refusal('limit', '10.0001', '10')).toBe('trade.zone_cap_exceeded');
  });

  it('takes no order at all while the owner cap is unset, never an uncapped one', () => {
    const unset = { ...zoned, zoneOrderCap: null };
    expect(refusal('limit', '1', '1', unset)).toBe('trade.zone_setting_unset');
    expect(refusal('market', null, '1', unset)).toBe('trade.zone_setting_unset');
  });

  it('restricts nothing outside the zone', () => {
    expect(refusal('market', null, '1', { ...zoned, zone: null })).toBeNull();
    expect(refusal('market', null, '1', { symbol: 'BTC/USDT', quoteAsset: 'USDT' })).toBeNull();
  });

  it('publishes the zone and its cap on the market read, and nothing for a market outside it', () => {
    const row = presentCcxtMarket(fakeMarket({ symbol: 'TRSK/USDC', zone: 'higher_risk', zoneOrderCap: parseAmount('100') }), Date.now());
    expect(row.zone).toBe('higher_risk');
    expect(row.zoneOrderCap).toBe('100');
    const unset = presentCcxtMarket(fakeMarket({ symbol: 'TRSK/USDC', zone: 'higher_risk', zoneOrderCap: null }), Date.now());
    expect(unset.zoneOrderCap).toBeNull();
    const plain = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT' }), Date.now());
    expect(plain.zone).toBeNull();
    expect(plain.zoneOrderCap).toBeNull();
  });
});
