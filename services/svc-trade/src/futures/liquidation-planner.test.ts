import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { planLiquidation, summarizeLiquidation, unrealizedPnl } from './liquidation-planner.js';

const USER = '11111111-1111-4111-8111-111111111111';

const base = {
  positionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: USER,
  side: 'long' as const,
  size: amt('1'),
  entryPrice: amt('50000'),
  margin: amt('5000'),
  marginAsset: 'USDT',
};

describe('liquidation-planner', () => {
  it('uPnL long: mark down is negative', () => {
    expect(formatAmount(unrealizedPnl('long', amt('1'), amt('50000'), amt('49000')))).toBe('-1000');
  });

  it('healthy long above named maintenance → skip', () => {
    const d = planLiquidation({
      liquidationId: 'liq-1',
      position: base,
      markPrice: '50000',
      maintenanceBps: 5000, // fixture — not product law (D3)
    });
    expect(d.liquidate).toBe(false);
    if (!d.liquidate) expect(d.reason).toBe('healthy');
  });

  it('omitted maintenanceBps does not invent 50% — parks unless equity is gone', () => {
    const d = planLiquidation({
      liquidationId: 'liq-d3',
      position: base,
      markPrice: '47000', // would liquidate under invented 5000 bps
    });
    expect(d.liquidate).toBe(false);
    if (!d.liquidate) expect(d.reason).toBe('maintenance_bps_unset');
  });

  it('long wiped by mark drop → full margin loss', () => {
    // entry 50k, mark 40k → uPnL -10k > margin 5k → insurance 5k
    const d = planLiquidation({
      liquidationId: 'liq-2',
      position: base,
      markPrice: '40000',
    });
    expect(d.liquidate).toBe(true);
    if (d.liquidate) {
      expect(formatAmount(d.loss)).toBe('10000');
      expect(formatAmount(d.fromMargin)).toBe('5000');
      expect(formatAmount(d.fromInsurance)).toBe('5000');
      expect(formatAmount(d.residualRelease)).toBe('0');
      expect(d.recipes.some((r) => r.reason === 'futures.loss.realized')).toBe(true);
      expect(summarizeLiquidation(d)).toContain('liquidate');
    }
  });

  it('long mild drawdown below 50% maintenance → liquidate with residual release', () => {
    // uPnL -3000, equity 2000, maintenance 2500 → liquidate
    // loss 3000, fromMargin 3000, residual 2000 release
    const d = planLiquidation({
      liquidationId: 'liq-3',
      position: base,
      markPrice: '47000',
      maintenanceBps: 5000,
    });
    expect(d.liquidate).toBe(true);
    if (d.liquidate) {
      expect(formatAmount(d.loss)).toBe('3000');
      expect(formatAmount(d.fromMargin)).toBe('3000');
      expect(formatAmount(d.fromInsurance)).toBe('0');
      expect(formatAmount(d.residualRelease)).toBe('2000');
      expect(d.recipes).toHaveLength(2);
    }
  });

  it('liqPrice cross forces liquidate even if equity healthy under high maintenanceBps=0', () => {
    const d = planLiquidation({
      liquidationId: 'liq-4',
      position: { ...base, liqPrice: amt('48000'), margin: amt('20000') },
      markPrice: '47000',
      maintenanceBps: 0,
    });
    // equity = 20000 - 3000 = 17000 > 0, maint 0 → would be healthy without liqPrice
    expect(d.liquidate).toBe(true);
    if (d.liquidate) expect(d.reason).toBe('mark_crossed_liq_price');
  });

  /**
   * The stored liq price bypasses the equity check, and used to carry no
   * validation beyond `> 0n`.
   *
   * `planLiquidation` realizes LOSSES ONLY — `loss = uPnL < 0n ? -uPnL : 0n`,
   * and no branch credits a gain. So a liquidation that fires while the
   * position is in profit hands the user their margin back and silently keeps
   * the profit: no error, no refusal, no log, because the plan is well-formed
   * and the recipes balance. 2 148 of 40 000 fuzzed cases did exactly that.
   *
   * The equity trigger cannot cause it — `uPnL > 0` implies
   * `equity > margin >= maintenance` for any `maintenanceBps <= 10 000`, and
   * with `liqPrice` disabled it was 0 of 20 000. The stored price is the only
   * way in, and a stale value after a margin top-up, a wrong sign, or a short's
   * price written onto a long all produce one.
   */
  it('refuses a liq price on the wrong side of entry instead of closing a winning position', () => {
    // The exact shape from the audit: long, entry 80, mark 120, liq 120.
    // A long liquidates when price FALLS, so a liq price at or above entry is
    // a data bug. Acting on it closes a position up 40 and pays none of it.
    const d = planLiquidation({
      liquidationId: 'liq-profit',
      position: { ...base, entryPrice: amt('80'), margin: amt('10'), liqPrice: amt('120') },
      markPrice: '120',
    });

    expect(d.liquidate).toBe(false);
    if (!d.liquidate) {
      expect(d.reason).toBe('liq_price_inconsistent_with_side');
      expect(formatAmount(d.unrealizedPnl)).toBe('40'); // the profit that used to vanish
    }
  });

  it('refuses a short whose liq price sits below entry', () => {
    // Mirror: a short liquidates when price RISES, so its liq price must be
    // above entry. This is the "short's price written onto a long" class, the
    // other way round.
    const d = planLiquidation({
      liquidationId: 'liq-short-bad',
      position: { ...base, side: 'short', entryPrice: amt('50000'), liqPrice: amt('48000') },
      markPrice: '47000',
    });

    expect(d.liquidate).toBe(false);
    if (!d.liquidate) expect(d.reason).toBe('liq_price_inconsistent_with_side');
  });

  it('still liquidates a losing position with a correctly-sided liq price', () => {
    // The guard must not cost the real case: long, liq price below entry,
    // mark through it, position under water.
    const d = planLiquidation({
      liquidationId: 'liq-ok',
      position: { ...base, liqPrice: amt('48000'), margin: amt('20000') },
      markPrice: '47000',
      maintenanceBps: 0,
    });

    expect(d.liquidate).toBe(true);
    if (d.liquidate) expect(d.reason).toBe('mark_crossed_liq_price');
  });

  it('short liquidates when mark rises past equity wipe', () => {
    const d = planLiquidation({
      liquidationId: 'liq-5',
      position: {
        ...base,
        side: 'short',
        margin: amt('5000'),
      },
      markPrice: '60000', // loss 10k
    });
    expect(d.liquidate).toBe(true);
    if (d.liquidate) {
      expect(formatAmount(d.fromMargin)).toBe('5000');
      expect(formatAmount(d.fromInsurance)).toBe('5000');
    }
  });

  it('does not invent a 50% maintenance table', () => {
    // Equity 4000 on 10000 margin is below a 50% maintenance line, yet still positive.
    const position = { ...base, entryPrice: amt('100000'), margin: amt('10000') };
    const omitted = planLiquidation({ liquidationId: 'liq-no-table', position, markPrice: '94000' });
    expect(omitted).toMatchObject({ liquidate: false, equity: amt('4000') });
    // Only a named maintenance line (a fixture, not product law) liquidates it.
    expect(planLiquidation({ liquidationId: 'liq-no-table', position, markPrice: '94000', maintenanceBps: 5000 })).toMatchObject({
      liquidate: true,
      reason: 'below_maintenance',
    });
  });
});
