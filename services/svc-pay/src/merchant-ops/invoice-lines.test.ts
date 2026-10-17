import { describe, expect, it } from 'vitest';
import { exactLineAmount, normalizeInvoiceLines, signedLineAmount, sumLineAmounts } from './invoice-lines.js';
import { MerchantOpsError } from './errors.js';
import { formatAmount } from '@intafaced/ledger-client';

describe('invoice line totals', () => {
  it('multiplies decimal quantity and unit amount without rounding', () => {
    expect(formatAmount(exactLineAmount('2', '1.25'))).toBe('2.5');
    expect(formatAmount(exactLineAmount('0.5', '0.2'))).toBe('0.1');
    expect(formatAmount(exactLineAmount('1', '0'))).toBe('0');
    const lines = normalizeInvoiceLines([
      { description: 'Widget', quantity: '2', unitAmount: '1.25' },
      { description: 'Seal', quantity: '1.5', unitAmount: '0.50' },
    ]);
    expect(lines).toEqual([
      { kind: 'charge', description: 'Widget', quantity: '2', unitAmount: '1.25', amount: '2.5' },
      { kind: 'charge', description: 'Seal', quantity: '1.5', unitAmount: '0.5', amount: '0.75' },
    ]);
    expect(formatAmount(sumLineAmounts(lines!))).toBe('3.25');
  });

  it('stores a credit as the negation of a positive unit amount and keeps a free charge at zero', () => {
    expect(formatAmount(signedLineAmount('credit', '2', '1.25'))).toBe('-2.5');
    const lines = normalizeInvoiceLines([
      { description: 'Work', quantity: '2', unitAmount: '5' },
      { description: 'Rebate', kind: 'credit', quantity: '1', unitAmount: '2.5' },
      { description: 'Sample', kind: 'charge', quantity: '3', unitAmount: '0' },
    ]);
    expect(lines).toEqual([
      { kind: 'charge', description: 'Work', quantity: '2', unitAmount: '5', amount: '10' },
      { kind: 'credit', description: 'Rebate', quantity: '1', unitAmount: '2.5', amount: '-2.5' },
      { kind: 'charge', description: 'Sample', quantity: '3', unitAmount: '0', amount: '0' },
    ]);
    expect(formatAmount(sumLineAmounts(lines!))).toBe('7.5');
    const omitted = normalizeInvoiceLines([{ description: 'One', quantity: '1', unitAmount: '2' }]);
    const explicit = normalizeInvoiceLines([{ description: 'One', quantity: '1', unitAmount: '2', kind: 'charge' }]);
    expect(omitted).toEqual(explicit);
  });

  it('refuses a product that does not fit 18 decimal places, a float, a non-positive quantity, and a zero credit', () => {
    expect(() => exactLineAmount('0.000000000000000003', '0.000000000000000003')).toThrow(MerchantOpsError);
    expect(() => exactLineAmount('0.000000000000000003', '0.000000000000000003')).toThrowError(
      expect.objectContaining({ code: 'pay.invoice_line_not_exact' }),
    );
    expect(() => exactLineAmount('1.5', '1')).not.toThrow();
    expect(() => normalizeInvoiceLines([{ description: 'x', quantity: '0.0000000001', unitAmount: '0.0000000001' }])).toThrowError(
      expect.objectContaining({ code: 'pay.invoice_line_not_exact' }),
    );
    expect(() => exactLineAmount('0', '1')).toThrowError(expect.objectContaining({ code: 'pay.invoice_line_invalid' }));
    expect(() => exactLineAmount('-1', '1')).toThrowError(expect.objectContaining({ code: 'pay.invoice_line_invalid' }));
    expect(() => exactLineAmount('1', 'nope')).toThrowError(expect.objectContaining({ code: 'pay.invoice_line_invalid' }));
    expect(() => signedLineAmount('credit', '1', '0')).toThrowError(expect.objectContaining({ code: 'pay.invoice_line_invalid' }));
    expect(() => normalizeInvoiceLines([{ description: 'x', kind: 'credit', quantity: '1', unitAmount: '-2' }])).toThrowError(
      expect.objectContaining({ code: 'pay.invoice_line_invalid' }),
    );
    expect(normalizeInvoiceLines(undefined)).toBeNull();
    expect(normalizeInvoiceLines([])).toBeNull();
  });
});
