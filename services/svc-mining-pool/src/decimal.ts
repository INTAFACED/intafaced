import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { MiningError } from './errors.js';

/** Exact decimal for an integer weight. No float, no 18-decimal money scale. */
export function canonicalWeight(raw: string): string {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new MiningError('Share weight is not an exact decimal', 'mining.amount_not_decimal');
  }
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.replace(/0+$/, '').length > 0) {
    throw new MiningError('Share weight is not an integer', 'mining.weight_not_integer');
  }
  return BigInt(whole ?? '0').toString();
}

/** Ledger money canonical form. Rewards and estimates only. */
export function canonicalMoney(raw: string): string {
  return formatAmount(parseAmount(raw.trim()));
}

export function weightToBigInt(raw: string): bigint {
  const canonical = canonicalWeight(raw);
  if (canonical === '0') throw new MiningError('Share weight is not positive', 'mining.weight_not_integer');
  return BigInt(canonical);
}
