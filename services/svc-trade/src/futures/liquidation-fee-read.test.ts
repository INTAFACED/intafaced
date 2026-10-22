/** D-margin-07: the liquidation read says "fee not set" when the owner fraction is unset. TEST figures only. */
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { encodeRungPlan } from './liquidation-rungs.js';
import { presentLiquidationRung } from './futures-reads.js';
import { LIQUIDATION_FEE_EXPLANATION, LIQUIDATION_FEE_UNSET } from './liquidation-fee.js';

function row(fee: string | null) {
  return {
    rung_id: 'r1',
    position_id: 'p1',
    liquidation_id: 'l1',
    kind: 'partial',
    created_at: new Date('2026-10-03T00:00:00.000Z'),
    plan: JSON.parse(
      JSON.stringify(
        encodeRungPlan({
          recipes: [],
          sizeClosed: parseAmount('0.2'),
          marginRemaining: parseAmount('1'),
          marginTaken: parseAmount('1'),
          releaseShort: 0n,
          lossShort: 0n,
          reason: 'partial',
          fromInsurance: 0n,
          marginAsset: 'USDT',
          ...(fee == null ? {} : { fee: parseAmount(fee) }),
        }),
      ),
    ),
  };
}

describe('liquidation read fee state (D-margin-07)', () => {
  it('no recorded fee and the fraction unset → fee null, feeReason fee_unset, with the explanation', () => {
    const wire = presentLiquidationRung(row(null), { feeFractionUnset: true });
    expect(wire.fee).toBeNull();
    expect(wire.feeReason).toBe(LIQUIDATION_FEE_UNSET);
    expect(wire.feeExplanation).toBe(LIQUIDATION_FEE_EXPLANATION);
  });

  it('no recorded fee and the fraction set → the existing not-recorded reason, no explanation', () => {
    const wire = presentLiquidationRung(row(null), { feeFractionUnset: false });
    expect(wire.feeReason).toBe('liquidation_fee_not_recorded');
    expect(wire).not.toHaveProperty('feeExplanation');
  });

  it('a recorded fee is shown as recorded whatever the fraction', () => {
    const wire = presentLiquidationRung(row('1.5'), { feeFractionUnset: true });
    expect(wire).toMatchObject({ fee: '1.5', feeReason: null });
    expect(wire).not.toHaveProperty('feeExplanation');
  });

  it('no context (older callers) keeps the previous wire exactly', () => {
    const wire = presentLiquidationRung(row(null));
    expect(wire.feeReason).toBe('liquidation_fee_not_recorded');
    expect(wire).not.toHaveProperty('feeExplanation');
  });
});
