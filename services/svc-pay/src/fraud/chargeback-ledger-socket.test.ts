import { describe, expect, it } from 'vitest';
import {
  CHARGEBACK_LEDGER_PLAN_CONFLICT_CODE,
  CHARGEBACK_LEDGER_REFUSE_CODE,
  CHARGEBACK_LEDGER_SOCKET_ID,
  CHARGEBACK_LEDGER_UNCOVERED_CODE,
  refuseChargebackLedgerPost,
  CHARGEBACK_SHORTFALL_UNFUNDED_CODE,
  refuseChargebackPlanConflict,
  refuseChargebackShortfallUnfunded,
  refuseChargebackUncovered,
} from './chargeback-ledger-socket.js';

describe('chargeback ledger §13 socket (D26-P1-P5)', () => {
  it('refuses a missing money port with a named socket id and code', () => {
    const r = refuseChargebackLedgerPost({ disputeId: 'dp_1', paymentId: 'pay_1' });
    expect(r.code).toBe(CHARGEBACK_LEDGER_REFUSE_CODE);
    expect(r.socket).toBe(CHARGEBACK_LEDGER_SOCKET_ID);
    expect(r.disputeId).toBe('dp_1');
    expect(r.paymentId).toBe('pay_1');
    expect(r.message).toMatch(/port absent/i);
    expect(r.message).toMatch(/no value moved/i);
  });

  it('refuses uncovered pots without inventing shortfall', () => {
    const r = refuseChargebackUncovered({ disputeId: 'dp_2', paymentId: 'pay_2' });
    expect(r.code).toBe(CHARGEBACK_LEDGER_UNCOVERED_CODE);
    expect(r.socket).toBe(CHARGEBACK_LEDGER_SOCKET_ID);
    expect(r.message).toMatch(/cannot cover/i);
    expect(r.message).toMatch(/shortfall/i);
    expect(r.message).toMatch(/no value moved/i);
  });

  it('names an unfunded shortfall without posting', () => {
    const r = refuseChargebackShortfallUnfunded({ disputeId: 'dp_4', paymentId: 'pay_4' });
    expect(r.code).toBe(CHARGEBACK_SHORTFALL_UNFUNDED_CODE);
    expect(r.code).toBe('pay.chargeback_shortfall_unfunded');
    expect(r.socket).toBe(CHARGEBACK_LEDGER_SOCKET_ID);
    expect(r.message).toMatch(/Insurance fund cannot cover/);
    expect(r.message).toMatch(/No opening and no shortfall were posted/);
  });

  it('names a plan conflict without moving value', () => {
    const r = refuseChargebackPlanConflict({ disputeId: 'dp_3', paymentId: 'pay_3' });
    expect(r.code).toBe(CHARGEBACK_LEDGER_PLAN_CONFLICT_CODE);
    expect(r.socket).toBe(CHARGEBACK_LEDGER_SOCKET_ID);
    expect(r.message).toMatch(/different amount/i);
    expect(r.message).toMatch(/no value moved/i);
  });

  it('never invents a success path', () => {
    const a = refuseChargebackLedgerPost({ disputeId: 'a', paymentId: 'b' });
    const b = refuseChargebackUncovered({ disputeId: 'a', paymentId: 'b' });
    expect(a.socket).toBe(CHARGEBACK_LEDGER_SOCKET_ID);
    expect(b.socket).toBe(CHARGEBACK_LEDGER_SOCKET_ID);
    expect(a.code).not.toBe(b.code);
  });
});
