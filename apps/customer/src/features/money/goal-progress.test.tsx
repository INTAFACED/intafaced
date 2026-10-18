import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store; read the stored preferences once.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { GoalProgress, MovementBars } from './GoalAndMovement';
import { goalChartCopy } from './goal-chart-copy';
import { goalShare, movementShares } from './goal-progress';

describe('goal share', () => {
  it('is exact, rounded down, and capped at the target', () => {
    expect(goalShare('0', '0.01')).toEqual({ basisPoints: 0, reached: false });
    expect(goalShare('0.0025', '0.01')).toEqual({ basisPoints: 2500, reached: false });
    expect(goalShare('0.00333333', '0.01')).toEqual({ basisPoints: 3333, reached: false });
    expect(goalShare('0.01', '0.01')).toEqual({ basisPoints: 10000, reached: true });
    expect(goalShare('5', '0.01')).toEqual({ basisPoints: 10000, reached: true });
  });
  it('draws nothing without a usable target', () => {
    expect(goalShare('1', null)).toBeNull();
    expect(goalShare('1', '0')).toBeNull();
    expect(goalShare('1', 'abc')).toBeNull();
  });
});

describe('movement shares', () => {
  it('scales the two totals against the larger one', () => {
    expect(movementShares('10', '5')).toEqual({ inflow: 10000, outflow: 5000 });
    expect(movementShares('0', '4')).toEqual({ inflow: 0, outflow: 10000 });
  });
  it('draws nothing when both are zero or unreadable', () => {
    expect(movementShares('0', '0')).toBeNull();
    expect(movementShares('x', '1')).toBeNull();
  });
});

describe('bank depth views', () => {
  it('writes the goal as "0 of 0.01 BTC" with a progress bar', () => {
    const html = renderToStaticMarkup(<GoalProgress balance="0" target="0.01" assetId="BTC" />);
    expect(html).toContain('0 of 0.01 BTC');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="0"');
  });
  it('shows nothing for a space with no target', () => {
    expect(renderToStaticMarkup(<GoalProgress balance="3" target={null} assetId="BTC" />)).toBe('');
  });
  it('gives the movement chart a table with the same figures', () => {
    const html = renderToStaticMarkup(<MovementBars inflow="12.5" outflow="4" net="8.5" assetId="USDT" />);
    expect(html).toContain('<table');
    expect(html).toContain('12.5 USDT');
    expect(html).toContain('8.5 USDT');
    expect(html).toContain('aria-hidden="true"');
  });
  it('has Spanish and French for every line', () => {
    for (const locale of ['es', 'fr'] as const) {
      const copy = goalChartCopy.forLocale(locale);
      expect(copy.t('goalProgress', { current: '0', target: '1', asset: 'BTC' })).not.toBe(
        goalChartCopy.forLocale('en').t('goalProgress', { current: '0', target: '1', asset: 'BTC' }),
      );
    }
  });
});
