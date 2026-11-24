import { describe, expect, it } from 'vitest';
import type { VenueMarket } from '../../../features/trade/venue-api';
import { calculateVenueMargin } from './venue-calculator-logic';

// J-derivatives-02 #1: venue standalone margin & P&L calculator, using only the venue's published market figures.

const XRSK: Pick<VenueMarket, 'marginTiers' | 'maintenanceMarginRate' | 'maxLeverageBps' | 'takerFeeBps'> = {
  maxLeverageBps: 200_000,
  takerFeeBps: { known: true, value: '4.5' },
  maintenanceMarginRate: { known: false },
  marginTiers: {
    known: true,
    value: [
      { fromNotional: '0', maxLeverageBps: 200_000, maintenanceRate: '0.025' },
      { fromNotional: '5000', maxLeverageBps: 100_000, maintenanceRate: '0.05' },
      { fromNotional: '25000', maxLeverageBps: 50_000, maintenanceRate: '0.1' },
    ],
  },
};

describe('calculateVenueMargin', () => {
  it('computes initial margin, tier maintenance, liquidation price, P&L, ROE and fees for a long', () => {
    // 10 XRSK @ 100, 5x -> notional 1000 (tier 1, 2.5%), margin 200, maint 25, cushion 17.5 -> liq 82.5.
    // Exit 110 -> P&L +100, ROE 50%.
    const r = calculateVenueMargin(XRSK, { side: 'long', size: '10', entryPrice: '100', exitPrice: '110', leverage: '5' }, '0.5');
    expect(r).toMatchObject({
      notional: '1000',
      initialMargin: '200',
      tier: { index: 1, maxLeverageBps: 200_000, maintenanceRate: '0.025' },
      maintenanceMargin: '25',
      liquidationPrice: '82.5',
      pnl: '100',
      roePercent: '50',
      // Fees: (1000 + 1100) * 5 bps = 2100 * 0.0005 = 1.05
      estimatedFees: '1.05',
      netPnl: '98.95',
      leverageWarning: null,
    });
  });

  it('computes short liquidation price above entry and warns when leverage exceeds the tier cap', () => {
    // 60 XRSK @ 100 = 6000 -> tier 2 (max 10x, maint 5%), 15x exceeds tier 2 cap.
    const r = calculateVenueMargin(XRSK, { side: 'short', size: '60', entryPrice: '100', exitPrice: '90', leverage: '15' }, null);
    expect(r?.tier).toEqual({ index: 2, maxLeverageBps: 100_000, maintenanceRate: '0.05' });
    expect(r?.pnl).toBe('600');
    expect(r?.leverageWarning).toEqual({ kind: 'tier', tier: 2, maxLeverage: '10' });
    expect(Number(r?.liquidationPrice)).toBeGreaterThan(100);
  });

  it('never invents maintenance or fees when the venue publishes none', () => {
    const bare = {
      maxLeverageBps: null,
      takerFeeBps: { known: false as const },
      maintenanceMarginRate: { known: false as const },
      marginTiers: { known: false as const },
    };
    const r = calculateVenueMargin(bare, { side: 'long', size: '2', entryPrice: '100', exitPrice: '105', leverage: '4' }, '0.5');
    expect(r).toMatchObject({
      notional: '200',
      initialMargin: '50',
      tier: null,
      maintenanceMargin: null,
      liquidationPrice: null,
      pnl: '10',
      roePercent: '20',
      estimatedFees: null,
      netPnl: null,
    });
  });
});
