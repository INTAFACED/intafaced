import { formatAmount, parseAmount } from '@intafaced/ledger-client';

/**
 * Fees divided by gross, for one asset.
 *
 * Both inputs are the ledger scale (18 decimal places). The quotient is a
 * fraction rounded down to {@link FEE_RATE_PLACES} decimal places. It is
 * `exact` when that truncation loses nothing, and `rounded` when it does.
 * A zero gross is not a rate. A negative input is refused.
 */

/** Decimal places of the published fraction. Not a fee and not a cap. */
export const FEE_RATE_PLACES = 6;
const RATE_SCALE = 10n ** BigInt(FEE_RATE_PLACES);

export type EffectiveRateStatus = 'exact' | 'rounded' | 'no_volume' | 'refused';

export interface EffectiveRate {
  readonly fees: string;
  readonly gross: string;
  readonly rate: string | null;
  readonly rateStatus: EffectiveRateStatus;
}

function formatFraction(scaled: bigint): string {
  const whole = scaled / RATE_SCALE;
  const frac = scaled % RATE_SCALE;
  if (frac === 0n) return whole.toString();
  const digits = frac.toString().padStart(FEE_RATE_PLACES, '0').replace(/0+$/, '');
  return `${whole}.${digits}`;
}

export function exactFeeRate(feesRaw: string, grossRaw: string): EffectiveRate {
  const fees = parseAmount(feesRaw);
  const gross = parseAmount(grossRaw);
  const feesText = formatAmount(fees);
  const grossText = formatAmount(gross);
  if (fees < 0n || gross < 0n) {
    return { fees: feesText, gross: grossText, rate: null, rateStatus: 'refused' };
  }
  if (gross === 0n) {
    return { fees: feesText, gross: grossText, rate: null, rateStatus: 'no_volume' };
  }
  const scaled = (fees * RATE_SCALE) / gross;
  const remainder = (fees * RATE_SCALE) % gross;
  return {
    fees: feesText,
    gross: grossText,
    rate: formatFraction(scaled),
    rateStatus: remainder === 0n ? 'exact' : 'rounded',
  };
}
