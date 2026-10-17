import { SCALE, formatAmount, parseAmount } from '@intafaced/ledger-client';

/**
 * Fees divided by gross, for one asset.
 *
 * Both inputs are the ledger scale (18 decimal places). The quotient is
 * published only when it lands exactly on that scale. A remainder is not
 * rounded, and a zero gross is not a rate of zero.
 */
export type EffectiveRateStatus = 'exact' | 'not_terminating' | 'gross_zero';

export interface EffectiveRate {
  readonly fees: string;
  readonly gross: string;
  readonly rate: string | null;
  readonly rateStatus: EffectiveRateStatus;
}

export function exactFeeRate(feesRaw: string, grossRaw: string): EffectiveRate {
  const fees = parseAmount(feesRaw);
  const gross = parseAmount(grossRaw);
  const feesText = formatAmount(fees);
  const grossText = formatAmount(gross);
  if (fees < 0n || gross < 0n) {
    return { fees: feesText, gross: grossText, rate: null, rateStatus: 'not_terminating' };
  }
  if (gross === 0n) {
    return { fees: feesText, gross: grossText, rate: null, rateStatus: 'gross_zero' };
  }
  const numerator = fees * SCALE;
  if (numerator % gross !== 0n) {
    return { fees: feesText, gross: grossText, rate: null, rateStatus: 'not_terminating' };
  }
  return { fees: feesText, gross: grossText, rate: formatAmount(numerator / gross), rateStatus: 'exact' };
}
