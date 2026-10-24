import { describe, expect, it } from 'vitest';
import { loanRefusal, loanStatementMonth } from './LoanDetail';
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
    expect(said('bank.loan_fee_unsupported')).toContain('cannot be collected');
    expect(said('bank.loan_terms_missing')).toContain('interest rate cannot be read');
    expect(said('bank.statement_too_large')).toContain('too many lines');
    // A refusal the page does not name keeps the service's own words: a missing scope is not "not yours".
    expect(loanRefusal(t, { code: 'FORBIDDEN', message: 'Missing scope bank:read', reason: 'forbidden' })).toBe('Missing scope bank:read');
    expect(loanRefusal(t, { message: 'The bank could not be reached.', reason: 'unreachable' })).toBe('The bank could not be reached.');
  });

  it("asks for a statement month up to the next month's first instant, so the last day's interest is in it", () => {
    expect(loanStatementMonth('2026-10')).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
    expect(loanStatementMonth('2026-12')).toEqual({ from: '2026-12-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' });
    expect(loanStatementMonth('2026-13')).toBeNull();
    expect(loanStatementMonth('')).toBeNull();
  });
});
