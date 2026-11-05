import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { mixedAssetSummary, summarizeMargin } from './margin-summary.js';

describe('summarizeMargin', () => {
  it('sums two positions exactly', () => {
    const summary = summarizeMargin({
      positions: [
        { initialMargin: '5000', maintenanceMargin: '250', collateral: '5000', unrealizedPnl: '100' },
        { initialMargin: '1500.5', maintenanceMargin: '75.25', collateral: '1500.5', unrealizedPnl: '-20' },
      ],
      available: '10000',
      haircutBps: 0,
    });
    expect(summary.totalInitialMargin).toBe('6500.5');
    expect(summary.totalMaintenanceMargin).toBe('325.25');
    expect(summary.equity).toBe('6580.5');
    const SCALE = 10n ** 18n;
    const ratio = ((parseAmount('325.25') * SCALE) / parseAmount('6580.5')) as Amount;
    expect(summary.marginRatio).toBe(formatAmount(ratio));
    expect(summary.buyingPower).toBe('3499.5');
    expect(summary.available).toBe('10000');
    expect(summary.usedMargin).toBe('6500.5');
    expect(summary.missing).toEqual([]);
  });

  it('used margin is the margin held now, not the opening stake, and names the asset it is in', () => {
    const summary = summarizeMargin({
      positions: [{ initialMargin: '5000', maintenanceMargin: '250', collateral: '5125.000000000000000001', unrealizedPnl: '0' }],
      available: '94874.999999999999999999',
      haircutBps: null,
      asset: 'USDT',
    });
    expect(summary.asset).toBe('USDT');
    expect(summary.usedMargin).toBe('5125.000000000000000001');
    expect(summary.totalInitialMargin).toBe('5000');
    expect(summary.available).toBe('94874.999999999999999999');
  });

  it('an unknown free balance or margin held stays null and is named, whatever the haircut', () => {
    const summary = summarizeMargin({
      positions: [{ initialMargin: '1', maintenanceMargin: '1', collateral: null, unrealizedPnl: '0' }],
      available: null,
      haircutBps: null,
    });
    expect(summary.available).toBeNull();
    expect(summary.usedMargin).toBeNull();
    expect(summary.asset).toBeNull();
    expect(summary.missing).toContainEqual({ field: 'available', code: 'missing_input' });
    expect(summary.missing).toContainEqual({ field: 'usedMargin', code: 'missing_input' });
  });

  it('a null maintenance margin nulls the ratio and names the field', () => {
    const summary = summarizeMargin({
      positions: [{ initialMargin: '5000', maintenanceMargin: null, collateral: '5000', unrealizedPnl: '0' }],
      available: '10000',
      haircutBps: 0,
    });
    expect(summary.totalInitialMargin).toBe('5000');
    expect(summary.totalMaintenanceMargin).toBeNull();
    expect(summary.marginRatio).toBeNull();
    expect(summary.missing).toContainEqual({ field: 'maintenanceMargin', code: 'missing_input' });
  });

  it('no positions returns zeros for the sums and null for the ratio', () => {
    const summary = summarizeMargin({ positions: [], available: '10000', haircutBps: 0 });
    expect(summary.totalInitialMargin).toBe('0');
    expect(summary.totalMaintenanceMargin).toBe('0');
    expect(summary.equity).toBe('0');
    expect(summary.excess).toBe('0');
    expect(summary.deficit).toBe('0');
    expect(summary.marginRatio).toBeNull();
  });

  it('buying power stays null and names the haircut when the config is blank', () => {
    const summary = summarizeMargin({
      positions: [{ initialMargin: '1', maintenanceMargin: '1', collateral: '1', unrealizedPnl: '0' }],
      available: '10',
      haircutBps: null,
    });
    expect(summary.buyingPower).toBeNull();
    expect(summary.missing).toContainEqual({ field: 'TRADE_COLLATERAL_HAIRCUT_BPS', code: 'haircut_unset' });
  });

  it('equity at or below zero leaves the ratio blank and names why', () => {
    const summary = summarizeMargin({
      positions: [{ initialMargin: '100', maintenanceMargin: '5', collateral: '100', unrealizedPnl: '-150' }],
      available: '0',
      haircutBps: null,
    });
    expect(summary.equity).toBe('-50');
    expect(summary.deficit).toBe('55');
    expect(summary.marginRatio).toBeNull();
    expect(summary.missing).toContainEqual({ field: 'marginRatio', code: 'equity_not_positive' });
    expect(summary.positions).toBe(1);
  });

  it('positions in two margin assets add nothing up and name why', () => {
    const summary = mixedAssetSummary(2);
    expect(summary.positions).toBe(2);
    for (const field of ['usedMargin', 'totalInitialMargin', 'totalMaintenanceMargin', 'equity', 'marginRatio', 'available'] as const) {
      expect(summary[field], field).toBeNull();
    }
    expect(summary.missing).toEqual([{ field: 'asset', code: 'margin_assets_mixed' }]);
  });
});
