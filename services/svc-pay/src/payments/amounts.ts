import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';

const DECIMAL = /^\d+(\.\d{1,18})?$/;

export type AmountBound = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'amount'; canonical: string; scaled: Amount };

/**
 * An omitted filter is absent. A blank, a space, or anything that is not an
 * unsigned decimal string is invalid — never treated as zero and never dropped.
 */
export function boundAmount(raw: string | undefined): AmountBound {
  if (raw === undefined) return { kind: 'absent' };
  const trimmed = raw.trim();
  if (trimmed !== raw || !DECIMAL.test(trimmed)) return { kind: 'invalid' };
  try {
    const scaled = parseAmount(trimmed);
    return { kind: 'amount', canonical: formatAmount(scaled), scaled };
  } catch {
    return { kind: 'invalid' };
  }
}
