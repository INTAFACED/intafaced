import { MAX_AMOUNT, SCALE, formatAmount, parseAmount } from '@intafaced/ledger-client';
import { MerchantOpsError } from './errors.js';

/**
 * Invoice line arithmetic.
 *
 * Quantity and unit amount are decimal strings. The line amount is their
 * product in the ledger's 18-decimal scale. A product that does not land on
 * that scale is refused: this file does not round, and it does not use a
 * floating-point number. Forty lines is a request-size bound, not a price.
 *
 * A charge may be zero (a free line). A credit arrives as a positive unit
 * amount and is stored negative. Quantity stays above zero either way.
 */

export const INVOICE_LINE_LIMIT = 40;
export const INVOICE_LINE_KINDS = ['charge', 'credit'] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

export interface InvoiceLineInput {
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  readonly kind?: InvoiceLineKind;
}

export interface InvoiceLineView {
  readonly kind: InvoiceLineKind;
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  /** Signed. A credit is negative. A free charge is zero. */
  readonly amount: string;
}

function scaled(raw: string, code: 'pay.invoice_line_invalid'): bigint {
  if (typeof raw !== 'string' || raw !== raw.trim() || raw.startsWith('+') || raw.startsWith('-') || raw.length === 0) {
    throw new MerchantOpsError(code, 'bad_request');
  }
  try {
    return parseAmount(raw);
  } catch {
    throw new MerchantOpsError(code, 'bad_request');
  }
}

function lineKind(raw: InvoiceLineKind | undefined): InvoiceLineKind {
  if (raw === undefined || raw === 'charge') return 'charge';
  if (raw === 'credit') return 'credit';
  throw new MerchantOpsError('pay.invoice_line_invalid', 'bad_request');
}

/**
 * Quantity times unit amount, exact at 18 decimal places.
 * Quantity must be above zero. The unit amount may be zero. The product is
 * the positive magnitude; `signedLineAmount` applies the credit sign.
 */
export function exactLineAmount(quantity: string, unitAmount: string): bigint {
  const left = scaled(quantity, 'pay.invoice_line_invalid');
  const right = scaled(unitAmount, 'pay.invoice_line_invalid');
  if (left <= 0n || right < 0n) throw new MerchantOpsError('pay.invoice_line_invalid', 'bad_request');
  const product = left * right;
  if (product % SCALE !== 0n) throw new MerchantOpsError('pay.invoice_line_not_exact', 'bad_request');
  const amount = product / SCALE;
  if (amount < 0n || amount > MAX_AMOUNT) throw new MerchantOpsError('pay.invoice_line_invalid', 'bad_request');
  return amount;
}

/** Charge keeps the magnitude. Credit stores its negation. A zero credit is refused. */
export function signedLineAmount(kind: InvoiceLineKind, quantity: string, unitAmount: string): bigint {
  const magnitude = exactLineAmount(quantity, unitAmount);
  if (kind === 'credit') {
    if (magnitude === 0n || magnitude > MAX_AMOUNT) throw new MerchantOpsError('pay.invoice_line_invalid', 'bad_request');
    return -magnitude;
  }
  return magnitude;
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
 * checked by the caller against the signed sum of `amount`. Kind defaults to
 * charge so an omitted kind and an explicit charge share one fingerprint.
 */
export function normalizeInvoiceLines(lines: readonly InvoiceLineInput[] | undefined): InvoiceLineView[] | null {
  if (lines === undefined || lines.length === 0) return null;
  if (lines.length > INVOICE_LINE_LIMIT) throw new MerchantOpsError('pay.invoice_lines_too_many', 'bad_request');
  return lines.map((line) => {
    const kind = lineKind(line.kind);
    const amount = signedLineAmount(kind, line.quantity, line.unitAmount);
    return {
      kind,
      description: lineDescription(line.description),
      quantity: formatAmount(scaled(line.quantity, 'pay.invoice_line_invalid')),
      unitAmount: formatAmount(scaled(line.unitAmount, 'pay.invoice_line_invalid')),
      amount: formatAmount(amount),
    };
  });
}

export function sumLineAmounts(lines: readonly InvoiceLineView[]): bigint {
  let total = 0n;
  for (const line of lines) total += parseAmount(line.amount);
  return total;
}
