import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import {
  REALIZED_LOSS_REASON,
  reconcileRungsToLedger,
  rungLossKey,
  type InsuranceCredit,
  type LedgerLossTx,
} from './liquidation-reconcile.js';
import type { RungPlan, RungRecord, RungState } from './liquidation-rungs.js';

function rung(
  id: string,
  o: { state?: RungState; marginTaken?: string; fromInsurance?: string; kind?: 'partial' | 'closing' } = {},
): RungRecord {
  const plan: RungPlan = {
    recipes: [],
    sizeClosed: amt('1'),
    marginRemaining: 0n,
    marginTaken: amt(o.marginTaken ?? '0'),
    releaseShort: 0n,
    lossShort: 0n,
    reason: 'ladder_partial',
    fromInsurance: amt(o.fromInsurance ?? '0'),
    marginAsset: 'USDT',
  };
  return {
    rungId: id,
    positionId: `pos-${id}`,
    liquidationId: `liq:pos-${id}`,
    kind: o.kind ?? 'partial',
    fromSize: amt('10'),
    fromMargin: amt('100'),
    plan,
    state: o.state ?? 'applied',
    planVersion: 0,
    marginDrift: 0n,
  };
}
const tx = (r: RungRecord, fromMargin: string, fromInsurance: string): LedgerLossTx => ({
  idempotencyKey: rungLossKey(r),
  meta: { positionId: r.positionId, fromMargin: amt(fromMargin).toString(), fromInsurance: amt(fromInsurance).toString() },
});
const credit = (r: RungRecord, amount: string, reason = REALIZED_LOSS_REASON): InsuranceCredit => ({
  idempotencyKey: rungLossKey(r),
  reason,
  amount: amt(amount),
});

describe('reconcileRungsToLedger', () => {
  it('rung loss key is the ledger key the rung posts', () => {
    expect(rungLossKey({ liquidationId: 'liq:p', rungId: 'r1' })).toBe('futures.loss:liq:p:rung:r1:loss');
  });

  it('clean: every applied rung matches its ledger tx and the fund moved by exactly the plans', () => {
    const a = rung('a', { marginTaken: '40' });
    const b = rung('b', { marginTaken: '100', fromInsurance: '60', kind: 'closing' });
    const out = reconcileRungsToLedger({
      rungs: [a, b],
      ledgerLossTxs: [tx(a, '40', '0'), tx(b, '100', '60')],
      insuranceCredits: [credit(b, '60')],
    });
    expect(out).toMatchObject({ checked: 2, mismatches: [], clean: true });
    expect(out.insurance).toMatchObject({ ledgerRungKeyed: amt('60'), plans: amt('60'), difference: 0n, ledgerOther: 0n });
  });

  it('fromMargin and fromInsurance in the ledger meta must equal the plan', () => {
    const a = rung('a', { marginTaken: '40', fromInsurance: '5' });
    const out = reconcileRungsToLedger({ rungs: [a], ledgerLossTxs: [tx(a, '39', '6')], insuranceCredits: [credit(a, '6')] });
    expect(out.clean).toBe(false);
    expect(out.mismatches).toEqual([
      { rungId: 'a', positionId: 'pos-a', kind: 'from_margin', expected: amt('40'), ledger: amt('39') },
      { rungId: 'a', positionId: 'pos-a', kind: 'from_insurance', expected: amt('5'), ledger: amt('6') },
    ]);
    expect(out.insurance.difference).toBe(amt('1')); // the fund moved 6 where the plan says 5
  });

  it('a plan that books a loss but has no ledger tx is loss_missing', () => {
    const a = rung('a', { marginTaken: '40' });
    const out = reconcileRungsToLedger({ rungs: [a], ledgerLossTxs: [], insuranceCredits: [] });
    expect(out.mismatches).toEqual([{ rungId: 'a', positionId: 'pos-a', kind: 'loss_missing', expected: amt('40'), ledger: null }]);
  });

  it('a plan that books nothing (an empty pot) and has no tx is clean; with a tx it is loss_unexpected', () => {
    const a = rung('a');
    expect(reconcileRungsToLedger({ rungs: [a], ledgerLossTxs: [], insuranceCredits: [] }).clean).toBe(true);
    const out = reconcileRungsToLedger({ rungs: [a], ledgerLossTxs: [tx(a, '1', '0')], insuranceCredits: [] });
    expect(out.mismatches.map((m) => m.kind)).toEqual(['loss_unexpected']);
  });

  it('unreadable meta is its own mismatch, not a silent pass', () => {
    const a = rung('a', { marginTaken: '40' });
    const out = reconcileRungsToLedger({
      rungs: [a],
      ledgerLossTxs: [{ idempotencyKey: rungLossKey(a), meta: { fromMargin: 'forty' } }],
      insuranceCredits: [],
    });
    expect(out.mismatches.map((m) => m.kind)).toEqual(['meta_unreadable']);
  });

  it("only APPLIED rungs are compared (a live rung is mid-booking, an abandoned one is the operator's)", () => {
    const live = rung('l', { state: 'posted', marginTaken: '40' });
    const gone = rung('g', { state: 'abandoned', marginTaken: '40' });
    const out = reconcileRungsToLedger({ rungs: [live, gone], ledgerLossTxs: [], insuranceCredits: [] });
    expect(out).toMatchObject({ checked: 0, mismatches: [], clean: true });
  });

  it('insurance credits under other keys (voluntary closes, pre-rung liquidations, unapplied rungs) are informational, other reasons are ignored', () => {
    const a = rung('a', { marginTaken: '40', fromInsurance: '5' });
    const live = rung('l', { state: 'posted', marginTaken: '1', fromInsurance: '9' });
    const out = reconcileRungsToLedger({
      rungs: [a, live],
      ledgerLossTxs: [tx(a, '40', '5')],
      insuranceCredits: [
        credit(a, '5'),
        credit(live, '9'), // booked, not applied yet
        { idempotencyKey: 'futures.loss:close:xyz:loss', reason: REALIZED_LOSS_REASON, amount: amt('3') },
        { idempotencyKey: 'insurance.topup:1', reason: 'insurance.topup', amount: amt('1000') },
      ],
    });
    expect(out.clean).toBe(true);
    expect(out.insurance).toMatchObject({ ledgerRungKeyed: amt('5'), plans: amt('5'), difference: 0n, ledgerOther: amt('12') });
  });

  it('a fund outflow with no plan behind it is a difference even when every tx matches', () => {
    const a = rung('a', { marginTaken: '40' });
    const out = reconcileRungsToLedger({ rungs: [a], ledgerLossTxs: [tx(a, '40', '0')], insuranceCredits: [credit(a, '7')] });
    expect(out.mismatches).toEqual([]);
    expect(out.insurance.difference).toBe(amt('7'));
    expect(out.clean).toBe(false);
  });
});
