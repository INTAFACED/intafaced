import { describe, expect, it } from 'vitest';
import type { VenueFill, VenuePosition } from '../venue-api';
import { breakEven, leverageBpsOfTimes, marginRatio, openingFees, pnlFormula, totalsOf, percentOf } from './positions-math';

// J-derivatives-05 #1 #2: the room's figures from the venue's own position and fills. Every figure is TEST.

const position = (over: Partial<VenuePosition> = {}): VenuePosition => ({
  symbol: 'BTC-PERP',
  side: 'long',
  size: '0.03',
  entryPrice: '60000',
  markPrice: '60010',
  unrealisedPnl: '0.3',
  marginMode: 'isolated',
  margin: '180',
  leverageBps: 100_000,
  liquidationPrice: { known: true, value: '54300' },
  maintenanceMargin: { known: true, value: '9' },
  ...over,
});

let at = 0;
const fill = (side: 'buy' | 'sell', amount: string, venueFee: string, builderFee = '0', realisedPnl: string | null = null): VenueFill => ({
  fillId: `f${(at += 1)}`,
  venueClientOrderId: null,
  symbol: 'BTC-PERP',
  side,
  price: '60000',
  amount,
  role: 'taker',
  venueFee,
  builderFee,
  feeAsset: 'USDC',
  realisedPnl,
  filledAt: new Date(Date.UTC(2026, 10, 18, 6, 0, at)).toISOString(),
});

describe('positions room figures', () => {
  it('totals are the sum of the rows, to the last digit', () => {
    const t = totalsOf([
      position(),
      position({ symbol: 'XSTK-PERP', size: '1.1', markPrice: '200.07', margin: '22.01', unrealisedPnl: '-0.123' }),
    ]);
    expect(t).toEqual({ count: 2, notional: '2020.377', margin: '202.01', unrealisedPnl: '0.177' });
  });

  it('break-even is entry plus the opening fees per unit for a long, minus them for a short, exactly', () => {
    const fills = [fill('buy', '0.01', '0.27', '0.06'), fill('buy', '0.02', '0.54')];
    expect(openingFees(position(), fills)).toBe('0.87');
    expect(breakEven(position(), fills)).toBe('60029');
    expect(breakEven(position({ side: 'short' }), fills)).toBe('59971');
    // A fee that does not divide evenly is carried to 18 places, never rounded to the tick.
    expect(breakEven(position(), [fill('buy', '0.03', '0.1')])).toBe('60003.333333333333333333');
  });

  it('fees from before the position was last flat do not count; a part close keeps the remaining share', () => {
    const fills = [
      fill('buy', '0.01', '5'),
      fill('sell', '0.01', '5', '0', '1'),
      fill('buy', '0.04', '0.8'),
      fill('sell', '0.01', '0.2', '0', '0.1'),
    ];
    expect(openingFees(position(), fills)).toBe('0.6');
  });

  it('margin ratio is maintenance over margin plus unrealised, in percent; not published or past liquidation say so', () => {
    expect(marginRatio(position())).toBe('4.99');
    expect(marginRatio(position({ maintenanceMargin: { known: false } }))).toBeNull();
    expect(marginRatio(position({ maintenanceMargin: undefined }))).toBeNull();
    expect(marginRatio(position({ unrealisedPnl: '-180' }))).toBe('liquidation');
  });

  it('the P&L formula carries the position’s own numbers and gives the venue’s figure', () => {
    expect(pnlFormula(position())).toEqual({ words: 'long', mark: '60010', entry: '60000', size: '0.03', result: '0.3' });
    expect(pnlFormula(position({ side: 'short' })).result).toBe('-0.3');
  });

  it('a leverage is a whole number of times', () => {
    expect(leverageBpsOfTimes('15')).toBe(150_000);
    for (const bad of ['0', '1.5', '', 'x', '-2']) expect(leverageBpsOfTimes(bad)).toBeNull();
  });

  it('a fraction the venue reports is drawn in percent to its last digit, nothing rounded', () => {
    expect(percentOf('0.050000000000000001')).toBe('5.0000000000000001');
    expect(percentOf('0.0123')).toBe('1.23');
    expect(percentOf('0')).toBe('0');
  });
});
