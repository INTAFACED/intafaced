import { describe, expect, it } from 'vitest';
import { loanRefusal } from './LoanDetail';
import { bankReads, loanStatementSchema } from './contracts';
import { loanDetailCopy } from './loan-detail-copy';

/** BK-loan-06 screen half (J-bank-11 #1): the bank's loan reads as their schemas, and what each refusal says. */

const t = loanDetailCopy.forLocale('en').t;

describe('loan details', () => {
  it('reads the projection only as a projection, never as an obligation', () => {
    const view = {
      loanId: 'l1',
      kind: 'projection',
      obligation: false,
      aprBps: 1000,
      days: 1,
      openingPrincipal: '100',
      openingInterest: '0',
      extraApplied: null,
      rows: [{ date: '2026-10-25', basis: '100', interest: '0.027397260273972602', principal: '100', debt: '100.027397260273972602' }],
    };
    expect(bankReads['loans.projection'].parse(view).rows[0]?.interest).toBe('0.027397260273972602');
    expect(() => bankReads['loans.projection'].parse({ ...view, obligation: true })).toThrow();
    expect(() => bankReads['loans.projection'].parse({ ...view, kind: 'schedule' })).toThrow();
  });

  it('reads the payoff quote and the statement as the bank sends them', () => {
    expect(
      bankReads['loans.payoffQuote'].parse({
        loanId: 'l1',
        principal: '100',
        interest: '0.4',
        fee: '0',
        total: '100.4',
        assetId: 'USDT',
        interestThrough: '2026-10-24',
        validUntil: '2026-10-24T11:25:58.422Z',
      }).total,
    ).toBe('100.4');
    expect(() => bankReads['loans.payoffQuote'].parse({ loanId: 'l1', total: 100.4 })).toThrow();
    expect(() => loanStatementSchema.parse({ format: 'pdf' })).toThrow();
  });

  it('says why a loan read was refused, with the bank code as a reference', () => {
    const said = (code: string) => loanRefusal(t, { code, message: 'raw', reason: 'error' });
    expect(said('bank.loan_fee_unset')).toBe(`${t('feeUnset')} Reference: bank.loan_fee_unset`);
    expect(said('bank.loan_payoff_window_unset')).toContain('how long it holds');
    expect(said('bank.loan_closed')).toContain('nothing is owed');
    expect(said('bank.loan_liquidating')).toContain('being sold');
    expect(said('bank.ledger_outcome_unknown')).toContain('still being confirmed');
    expect(said('bank.loan_not_found')).toContain('not one of yours');
    expect(loanRefusal(t, { code: 'FORBIDDEN', message: 'raw', reason: 'forbidden' })).toBe(t('notYours'));
    expect(loanRefusal(t, { message: 'The bank could not be reached.', reason: 'unreachable' })).toBe('The bank could not be reached.');
  });
});
