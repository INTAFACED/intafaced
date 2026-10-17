import { describe, expect, it } from 'vitest';
import { exactLineAmount, normalizeInvoiceLines, sumLineAmounts } from './invoice-lines.js';
import { MerchantOpsError } from './errors.js';
import { formatAmount } from '@intafaced/ledger-client';

describe('invoice line totals', () => {
  it('multiplies decimal quantity and unit amount without rounding', () => {
    expect(formatAmount(exactLineAmount('2', '1.25'))).toBe('2.5');
    expect(formatAmount(exactLineAmount('0.5', '0.2'))).toBe('0.1');
    const lines = normalizeInvoiceLines([
      { description: 'Widget', quantity: '2', unitAmount: '1.25' },
      { description: 'Seal', quantity: '1.5', unitAmount: '0.50' },
    ]);
    expect(lines).toEqual([
      { description: 'Widget', quantity: '2', unitAmount: '1.25', amount: '2.5' },
      { description: 'Seal', quantity: '1.5', unitAmount: '0.5', amount: '0.75' },
    ]);
    expect(formatAmount(sumLineAmounts(lines!))).toBe('3.25');
  });

  it('refuses a product that does not fit 18 decimal places, a float, and a non-positive amount', () => {
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
    expect(normalizeInvoiceLines(undefined)).toBeNull();
    expect(normalizeInvoiceLines([])).toBeNull();
  });
});
