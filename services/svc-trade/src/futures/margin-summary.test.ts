import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { summarizeMargin } from './margin-summary.js';

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
    expect(summary.missing).toEqual([]);
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
});
