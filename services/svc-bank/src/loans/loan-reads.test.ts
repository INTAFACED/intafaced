import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { dailyLoanInterest } from './risk.js';
import { applyInterestFirst, parsePayoffFee, parsePayoffWindowMinutes, projectLoanDays, quotePayoff } from './loan-reads.js';

const AS_OF = new Date('2026-06-01T12:00:00.000Z');
const CHARGED_THROUGH = '2026-06-01';

describe('loan projection (BK-loan-06)', () => {
  it('matches dailyLoanInterest for 30 days and is not an obligation', () => {
    const principal = parseAmount('100');
    const projected = projectLoanDays({ loanId: 'loan', principal, interest: 0n, aprBps: 500, days: 30, chargedThrough: CHARGED_THROUGH });
    expect(projected.kind).toBe('projection');
    expect(projected.obligation).toBe(false);
    expect(projected.rows).toHaveLength(30);
    expect(projected.rows[0]!.date).toBe('2026-06-02');
    let debt = principal;
    for (const row of projected.rows) {
      const interest = dailyLoanInterest(debt, 500);
      expect(row.interest).toBe(formatAmount(interest));
      expect(row.basis).toBe(formatAmount(debt));
      debt += interest;
      expect(row.debt).toBe(formatAmount(debt));
      expect(row.principal).toBe(formatAmount(principal));
    }
  });

  it('applies an extra repayment interest-first before the first day', () => {
    const split = applyInterestFirst(parseAmount('100'), parseAmount('0.40'), parseAmount('50'));
    expect(formatAmount(split.interest)).toBe('0');
    expect(formatAmount(split.principal)).toBe('50.4');
    const projected = projectLoanDays({
      loanId: 'loan',
      principal: parseAmount('100'),
      interest: parseAmount('0.40'),
      aprBps: 500,
      days: 1,
      chargedThrough: CHARGED_THROUGH,
      extraRepayment: parseAmount('50'),
    });
    expect(projected.openingInterest).toBe('0');
    expect(projected.openingPrincipal).toBe('50.4');
    expect(projected.extraApplied).toBe('50');
    expect(projected.rows[0]!.interest).toBe(formatAmount(dailyLoanInterest(parseAmount('50.4'), 500)));
  });

  it('refuses a blank fee and a blank window, and accepts a published zero fee', () => {
    expect(() => parsePayoffFee(undefined)).toThrow(expect.objectContaining({ code: 'bank.loan_fee_unset' }));
    expect(() => parsePayoffFee('')).toThrow(expect.objectContaining({ code: 'bank.loan_fee_unset' }));
    expect(() => parsePayoffFee('nope')).toThrow(expect.objectContaining({ code: 'bank.loan_fee_unset' }));
    expect(parsePayoffFee('0')).toBe(0n);
    expect(() => parsePayoffWindowMinutes(undefined)).toThrow(expect.objectContaining({ code: 'bank.loan_payoff_window_unset' }));
    expect(() => parsePayoffWindowMinutes('0')).toThrow(expect.objectContaining({ code: 'bank.loan_payoff_window_unset' }));
    expect(parsePayoffWindowMinutes('15')).toBe(15);
    expect(() => parsePayoffFee('1.25')).toThrow(expect.objectContaining({ code: 'bank.loan_fee_unsupported' }));
    const quote = quotePayoff({
      loanId: 'loan',
      principal: parseAmount('100'),
      interest: parseAmount('0.40'),
      aprBps: 500,
      unchargedDays: [],
      assetId: 'USDT',
      feeRaw: '0',
      windowRaw: '15',
      now: AS_OF,
    });
    expect(quote).toMatchObject({
      principal: '100',
      interest: '0.4',
      fee: '0',
      total: '100.4',
      interestThrough: '2026-06-01',
      validUntil: '2026-06-01T12:15:00.000Z',
    });
  });

  it('starts the projection at the first day accrual has not charged', () => {
    const projected = projectLoanDays({
      loanId: 'loan',
      principal: parseAmount('100'),
      interest: 0n,
      aprBps: 500,
      days: 3,
      chargedThrough: '2026-05-29',
    });
    expect(projected.rows.map((row) => row.date)).toEqual(['2026-05-30', '2026-05-31', '2026-06-01']);
  });

  it('adds the uncharged days through today, and holds no later than the end of the UTC day', () => {
    const principal = parseAmount('100');
    const quote = quotePayoff({
      loanId: 'loan',
      principal,
      interest: 0n,
      aprBps: 500,
      unchargedDays: ['2026-05-31', '2026-06-01'],
      assetId: 'USDT',
      feeRaw: '0',
      windowRaw: '1440',
      now: new Date('2026-06-01T23:00:00.000Z'),
    });
    const day1 = dailyLoanInterest(principal, 500);
    const day2 = dailyLoanInterest(principal + day1, 500);
    expect(quote.interest).toBe(formatAmount(day1 + day2));
    expect(quote.total).toBe(formatAmount(principal + day1 + day2));
    expect(quote.validUntil).toBe('2026-06-02T00:00:00.000Z');
  });
});
