import type { FounderMerchantDrilldown } from '@intafaced/contracts';
import { formatAmount } from './money';

/** 250 -> "2.5%", 150 -> "1.5%", 100 -> "1%". Integer arithmetic; a fee is shown as a percent, never as basis points. */
export function percentText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${whole}${frac === '' ? '' : `.${frac}`}%`;
}

type PricingRules = NonNullable<FounderMerchantDrilldown['control']['pricing']>;

const RANK = { merchant: 3, tier: 2, global: 1 } as const;
const LAYER_WORDS = { merchant: 'this merchant’s own rule', tier: 'its tier’s rule', global: 'the global rule' } as const;

export interface FeeLine {
  readonly assetCode: string;
  /** "2.5%" or "from 0: 2.5%, from 1,000: 2%". */
  readonly percent: string;
  readonly flat: string | null;
  readonly layerWords: string;
}

/** The rule in force for each asset (most specific layer wins), as percent text. */
export function feeLines(rules: PricingRules | null): FeeLine[] {
  if (!rules) return [];
  const assets = [...new Set(rules.map((r) => r.assetCode))].sort();
  return assets.flatMap((assetCode) => {
    const winner = rules.filter((r) => r.assetCode === assetCode).sort((a, b) => RANK[b.layer] - RANK[a.layer])[0];
    if (!winner) return [];
    const bands = winner.bands;
    const percent =
      bands.length === 1 && bands[0]
        ? percentText(bands[0].feeBps)
        : bands.map((b) => `from ${formatAmount(b.fromAmount)}: ${percentText(b.feeBps)}`).join(', ');
    const flats = bands.filter((b) => b.flatFee !== null && /[1-9]/.test(b.flatFee));
    return [
      {
        assetCode,
        percent,
        flat:
          flats.length === 1 && flats[0]?.flatFee
            ? `${formatAmount(flats[0].flatFee)} ${assetCode}`
            : flats.length > 1
              ? 'a flat part per band'
              : null,
        layerWords: LAYER_WORDS[winner.layer],
      },
    ];
  });
}

export const FEE_WORKED_OUT_AT_SETTLEMENT = 'Fee is worked out when a payment settles; none has settled.';
export const FEE_NOT_CONFIGURED = 'The merchant’s own fee is set on its account; this console’s pricing rules do not include it.';
export const FEE_NOT_RECORDED = 'No fee was recorded for this settled payment.';

/** True when the status mix of the selected window holds at least one settled payment. */
export function hasSettledPayment(statusMix: readonly { status: string; count: number }[]): boolean {
  return statusMix.some((s) => s.status === 'settled' && s.count > 0);
}
