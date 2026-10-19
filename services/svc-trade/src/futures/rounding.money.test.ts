import { describe, expect, it } from 'vitest';
import { parseAmount as amt, mul } from '@intafaced/ledger-client';
import { initialMargin } from './initial-margin.js';
import { planLiquidation, unrealizedPnl } from './liquidation-planner.js';
import { fundingAmount, notionalQuote } from './funding-settlement.js';

/**
 * Futures margin and funding math states its rounding. Money the house requires rounds up; money credited to a
 * trader rounds down; a plain bigint `/` truncated toward zero and so did the opposite for a loss.
 */

describe('initial margin rounds up and rounds once', () => {
  it('never locks less than notional / leverage, down to the last scaled unit', () => {
    const size = amt('1');
    const entryPrice = amt('100.000000000000000001');
    const leverage = amt('3');
    const margin = initialMargin({ size, entryPrice, leverage });
    const notional = mul(size, entryPrice, 'ceil');
    // 100.000000000000000001 / 3 = 33.333333333333333333666...: the floor undershoots, the ceil does not.
    expect(margin).toBe(amt('33.333333333333333334'));
    expect(mul(margin, leverage, 'floor') >= notional).toBe(true);
  });

  it('does not truncate the notional before dividing by leverage', () => {
    // size 1e-18 at 1.5 has a true notional of 1.5e-18 (rounds up to 2 units), margin at 1x must cover it.
    const margin = initialMargin({ size: 1n, entryPrice: amt('1.5'), leverage: amt('1') });
    expect(margin).toBe(2n);
  });
});

describe('unrealized PnL rounds toward the house', () => {
  it('a loss of a fraction of a unit rounds to a bigger loss, a gain to a smaller gain', () => {
    // size 1e-18 * 0.5 = half a scaled unit.
    expect(unrealizedPnl('long', 1n, amt('100'), amt('100.5'))).toBe(0n);
    expect(unrealizedPnl('long', 1n, amt('100'), amt('99.5'))).toBe(-1n);
    expect(unrealizedPnl('short', 1n, amt('100'), amt('100.5'))).toBe(-1n);
  });
});

describe('maintenance rounds up', () => {
  it('a position whose equity equals the rounded-up maintenance is liquidatable', () => {
    // margin 3 units at 50% maintenance: true 1.5 units, required 2. Equity 2 must liquidate.
    const decision = planLiquidation({
      liquidationId: 'liq-round',
      position: {
        positionId: 'p1',
        userId: '11111111-1111-4111-8111-111111111111',
        marketId: 'm1',
        side: 'long',
        size: amt('1'),
        entryPrice: amt('100'),
        margin: 3n,
        marginAsset: 'USDT',
      } as never,
      markPrice: '99.999999999999999999',
      maintenanceBps: 5000,
    });
    // uPnL = floor(-1e-18 * 1) = -1 unit, equity = 2, maintenance = ceil(1.5) = 2.
    expect(decision.liquidate).toBe(true);
  });
});

describe('funding states its rounding', () => {
  it('the notional and the payment never exceed the true value (zero-sum: a payer is never over-charged)', () => {
    expect(notionalQuote(1n, amt('1.5'))).toBe(1n);
    expect(fundingAmount(3n, amt('0.5'))).toBe(1n);
    expect(fundingAmount(3n, amt('0.5'))).toBe(mul(3n, amt('0.5'), 'floor'));
  });
});
