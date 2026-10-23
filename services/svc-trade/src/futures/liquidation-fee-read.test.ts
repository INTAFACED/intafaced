/** D-margin-07: the liquidation read says "fee not set" when the owner fraction is unset. TEST figures only. */
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { decodeRungPlan, encodeRungPlan } from './liquidation-rungs.js';
import { presentLiquidationRung } from './futures-reads.js';
import { LIQUIDATION_FEE_EXPLANATION, LIQUIDATION_FEE_UNSET } from './liquidation-fee.js';

function row(fee: string | null, feeState?: 'fee_unset' | 'ledger_job_pending', plannedFee?: string) {
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
          ...(feeState ? { feeState } : {}),
          ...(plannedFee ? { plannedFee: parseAmount(plannedFee) } : {}),
        }),
      ),
    ),
  };
}

describe('liquidation read fee state comes from the rung (D-margin-07)', () => {
  it('a rung that stored fee_unset → fee null, feeReason fee_unset, with the explanation', () => {
    const wire = presentLiquidationRung(row(null, 'fee_unset'));
    expect(wire.fee).toBeNull();
    expect(wire.feeReason).toBe(LIQUIDATION_FEE_UNSET);
    expect(wire.feeExplanation).toBe(LIQUIDATION_FEE_EXPLANATION);
  });

  it('a rung that stored ledger_job_pending → planned fee shown as planned, fee null (not charged)', () => {
    const wire = presentLiquidationRung(row(null, 'ledger_job_pending', '2.5'));
    expect(wire).toMatchObject({ fee: null, feeReason: 'ledger_job_pending', plannedFee: '2.5' });
  });

  it('a rung with no stored decision keeps the not-recorded reason, whatever the config is today', () => {
    const wire = presentLiquidationRung(row(null));
    expect(wire.feeReason).toBe('liquidation_fee_not_recorded');
    expect(wire).not.toHaveProperty('feeExplanation');
  });

  it('a recorded fee wins over any stored decision', () => {
    const wire = presentLiquidationRung(row('1.5', 'fee_unset'));
    expect(wire).toMatchObject({ fee: '1.5', feeReason: null });
    expect(wire).not.toHaveProperty('feeExplanation');
  });

  it('the decision survives encode → decode of the rung plan', () => {
    const plan = decodeRungPlan(row(null, 'ledger_job_pending', '2.5').plan);
    expect(plan).toMatchObject({ feeState: 'ledger_job_pending', plannedFee: parseAmount('2.5') });
  });
});
