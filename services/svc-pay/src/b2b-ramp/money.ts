import { MoneyError, formatAmount, parseAmount } from '@intafaced/ledger-client';
import { B2bRampError } from './errors.js';

/**
 * Amounts cross this module as decimal strings and are compared as scaled
 * bigint. There is no fee, cap, or minimum above zero: zero and below are
 * not a bank receipt, and a malformed string is rejected rather than coerced.
 */
export function parsePositiveAmount(input: string): { scaled: bigint; canonical: string } {
  if (typeof input !== 'string') throw new B2bRampError('pay.b2b_ramp_amount_rejected', 'bad_request');
  let scaled: bigint;
  try {
    scaled = parseAmount(input);
  } catch (error) {
    if (error instanceof MoneyError) throw new B2bRampError('pay.b2b_ramp_amount_rejected', 'bad_request');
    throw error;
  }
  if (scaled <= 0n) throw new B2bRampError('pay.b2b_ramp_amount_rejected', 'bad_request');
  return { scaled, canonical: formatAmount(scaled) };
}

/** True when both decimal strings are the same scaled amount. A corrupt stored value does not match. */
export function sameAmount(stored: string, canonical: string): boolean {
  try {
    return parseAmount(stored) === parseAmount(canonical);
  } catch {
    return false;
  }
}

/** Asset code as the statement wrote it, trimmed. No currency list is invented here. */
export function parseAsset(input: string): string {
  if (typeof input !== 'string') throw new B2bRampError('pay.b2b_ramp_asset_rejected', 'bad_request');
  const asset = input.trim();
  if (asset.length === 0 || /\s/.test(asset)) throw new B2bRampError('pay.b2b_ramp_asset_rejected', 'bad_request');
  return asset;
}
