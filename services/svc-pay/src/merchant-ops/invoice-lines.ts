import { MAX_AMOUNT, SCALE, formatAmount, parseAmount } from '@intafaced/ledger-client';
import { MerchantOpsError } from './errors.js';

/**
 * Invoice line arithmetic.
 *
 * Quantity and unit amount are decimal strings. The line amount is their
 * product in the ledger's 18-decimal scale. A product that does not land on
 * that scale is refused: this file does not round, and it does not use a
 * floating-point number. Forty lines is a request-size bound, not a price.
 */

export const INVOICE_LINE_LIMIT = 40;

export interface InvoiceLineInput {
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
}

export interface InvoiceLineView {
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  readonly amount: string;
}

function positive(raw: string, code: 'pay.invoice_line_invalid'): bigint {
  if (typeof raw !== 'string' || raw !== raw.trim() || raw.startsWith('+') || raw.startsWith('-') || raw.length === 0) {
    throw new MerchantOpsError(code, 'bad_request');
  }
  let amount: bigint;
  try {
    amount = parseAmount(raw);
  } catch {
    throw new MerchantOpsError(code, 'bad_request');
  }
  if (amount <= 0n) throw new MerchantOpsError(code, 'bad_request');
  return amount;
}

/** Quantity times unit amount, exact at 18 decimal places. */
export function exactLineAmount(quantity: string, unitAmount: string): bigint {
  const left = positive(quantity, 'pay.invoice_line_invalid');
  const right = positive(unitAmount, 'pay.invoice_line_invalid');
  const product = left * right;
  if (product % SCALE !== 0n) throw new MerchantOpsError('pay.invoice_line_not_exact', 'bad_request');
  const amount = product / SCALE;
  if (amount <= 0n || amount > MAX_AMOUNT) throw new MerchantOpsError('pay.invoice_line_invalid', 'bad_request');
  return amount;
}

function lineDescription(raw: string): string {
  const description = raw.trim();
  if (description.length < 1 || description.length > 500 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw new MerchantOpsError('pay.invoice_line_invalid', 'bad_request');
  }
  return description;
}

/**
 * Canonical lines, or null when the caller sent none. The header amount is
 * checked by the caller against the sum of `amount`.
 */
export function normalizeInvoiceLines(lines: readonly InvoiceLineInput[] | undefined): InvoiceLineView[] | null {
  if (lines === undefined || lines.length === 0) return null;
  if (lines.length > INVOICE_LINE_LIMIT) throw new MerchantOpsError('pay.invoice_lines_too_many', 'bad_request');
  return lines.map((line) => {
    const amount = exactLineAmount(line.quantity, line.unitAmount);
    return {
      description: lineDescription(line.description),
      quantity: formatAmount(positive(line.quantity, 'pay.invoice_line_invalid')),
      unitAmount: formatAmount(positive(line.unitAmount, 'pay.invoice_line_invalid')),
      amount: formatAmount(amount),
    };
  });
}

export function sumLineAmounts(lines: readonly InvoiceLineView[]): bigint {
  let total = 0n;
  for (const line of lines) total += parseAmount(line.amount);
  return total;
}
