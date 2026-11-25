import { describe, expect, it } from 'vitest';
import type { VenueMarket, VenuePosition } from '../../../features/trade/venue-api';
import {
  bpsToPercent,
  buyingPower,
  clampToBand,
  percentOf,
  planSplitOrders,
  projectedVenueTier,
  roomLeft,
  takenAssets,
} from './venue-risk-logic';

// J-derivatives-02 #3 #7: buying power and the room under the open-interest cap, only from the venue's own figures.

const market = (over: Partial<VenueMarket>) => ({ symbol: 'XRSK-PERP', ...over }) as VenueMarket;

describe('venue risk figures', () => {
  it('reads a scaled rate as an exact percent', () => {
    expect(percentOf('0.025')).toBe('2.5');
    expect(percentOf('0')).toBe('0');
  });

  it('counts only what the venue takes, less its haircut, and refuses to guess an unpublished haircut', () => {
    const free = (a: string) => ({ USDC: '1000', USDT: '200', BTC: '1' })[a] ?? '0';
    expect(buyingPower([{ asset: 'USDC', haircut: { known: true, value: '0' } }], free)).toEqual({ known: true, value: '1000' });
    expect(
      buyingPower(
        [
          { asset: 'USDC', haircut: { known: true, value: '0' } },
          { asset: 'USDT', haircut: { known: true, value: '0.02' } },
        ],
        free,
      ),
    ).toEqual({ known: true, value: '1196' });
    expect(buyingPower([{ asset: 'USDT', haircut: { known: false } }], free)).toEqual({ known: false, asset: 'USDT' });
    // A taken asset the person holds none of needs no haircut.
    expect(buyingPower([{ asset: 'DAI', haircut: { known: false } }], free)).toEqual({ known: true, value: '0' });
  });

  it('gives the room under the cap from the venue figures, none where it reports no cap', () => {
    expect(roomLeft(market({ openInterest: { known: true, value: { size: '12.5', capSize: '13' } } }))).toBe('0.5');
    expect(roomLeft(market({ openInterest: { known: true, value: { size: '14', capSize: '13' } } }))).toBe('0');
    expect(roomLeft(market({ openInterest: { known: true, value: { size: '1', capSize: null } } }))).toBeNull();
    expect(roomLeft(market({ openInterest: { known: false } }))).toBeNull();
  });

  it('lists what the venue takes, or null where it publishes no list', () => {
    expect(takenAssets(market({ collateral: { known: true, value: [{ asset: 'USDC', haircut: { known: false } }] } }))).toEqual(['USDC']);
    expect(takenAssets(market({ collateral: { known: false } }))).toBeNull();
    expect(takenAssets(market({}))).toBeNull();
  });

  it('formats bps to exact percent', () => {
    expect(bpsToPercent('500')).toBe('5');
    expect(bpsToPercent('1250')).toBe('12.5');
  });

  it('clamps prices outside the band onto the nearer tick inside the band', () => {
    const band = { bandLow: '95', bandHigh: '105' };
    expect(clampToBand('100', band, '0.01')).toEqual({ outside: false, adjusted: '100' });
    expect(clampToBand('80', band, '0.01')).toEqual({ outside: true, side: 'low', adjusted: '95' });
    expect(clampToBand('120', band, '0.01')).toEqual({ outside: true, side: 'high', adjusted: '105' });
    // Non-tick edges round inward so the clamped order always sits inside the band.
    expect(clampToBand('80', { bandLow: '95.004', bandHigh: '104.996' }, '0.01')).toEqual({
      outside: true,
      side: 'low',
      adjusted: '95.01',
    });
    expect(clampToBand('120', { bandLow: '95.004', bandHigh: '104.996' }, '0.01')).toEqual({
      outside: true,
      side: 'high',
      adjusted: '104.99',
    });
  });

  it('plans lot-aligned split orders summing exactly to size when above maxOrderNotional or maxOrderQty', () => {
    const m = { baseAsset: 'XRSK', quoteAsset: 'USDC', lotSize: '0.1', maxOrderQty: '1000', maxOrderNotional: '2000' };
    expect(planSplitOrders('15', '100', m)).toBeNull();
    // 30 XRSK at 95 = 2,850 USDC > 2,000 cap -> 2 orders of 15 XRSK (each 1,425 <= 2,000).
    expect(planSplitOrders('30', '95', m)).toEqual({
      splitable: true,
      parts: ['15', '15'],
      capLabel: '2000 USDC',
    });
    // Odd lot count splits evenly with remainder distributed by lot.
    expect(planSplitOrders('30.1', '95', m)).toEqual({
      splitable: true,
      parts: ['15.1', '15'],
      capLabel: '2000 USDC',
    });
  });

  it('computes projected venue margin tier and confirmRequired when adding crosses a tier threshold', () => {
    const m = market({
      marginTiers: {
        known: true,
        value: [
          { fromNotional: '0', maxLeverageBps: 200_000, maintenanceRate: '0.025' },
          { fromNotional: '5000', maxLeverageBps: 100_000, maintenanceRate: '0.05' },
        ],
      },
    });
    const pos = [{ symbol: 'XRSK-PERP', side: 'long', size: '30', entryPrice: '100' }] as VenuePosition[];
    // Tier 1 open (30 @ 100 = 3,000) -> no confirm.
    expect(projectedVenueTier(m, [], 'buy', '30', '100', false)).toEqual({
      current: null,
      projected: 1,
      maxLeverageBps: 200_000,
      maintenanceRate: '0.025',
      confirmRequired: false,
    });
    // Adding 30 to existing 30 -> 6,000 -> crosses Tier 1 to Tier 2 -> confirmRequired: true.
    expect(projectedVenueTier(m, pos, 'buy', '30', '100', false)).toEqual({
      current: 1,
      projected: 2,
      maxLeverageBps: 100_000,
      maintenanceRate: '0.05',
      confirmRequired: true,
    });
    // Reduce-only close -> never requires confirm.
    expect(projectedVenueTier(m, pos, 'sell', '30', '100', true)?.confirmRequired).toBe(false);
  });
});
