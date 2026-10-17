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
  /** One band: "2.5%" or "2.5% + 0.30 USDT flat". Several: "from 0.00: 2.5%, from 1,000.00: 2% + 0.10 USDT flat". */
  readonly percent: string;
  /** True when the rule has more than one band (steps by the merchant's monthly volume). */
  readonly stepped: boolean;
  readonly layerWords: string;
}

/** The rule in force for each asset (most specific layer wins), as percent text. A flat fee sits on the band it belongs to. */
export function feeLines(rules: PricingRules | null): FeeLine[] {
  if (!rules) return [];
  const assets = [...new Set(rules.map((r) => r.assetCode))].sort();
  return assets.flatMap((assetCode) => {
    const winner = rules.filter((r) => r.assetCode === assetCode).sort((a, b) => RANK[b.layer] - RANK[a.layer])[0];
    if (!winner) return [];
    const part = (b: PricingRules[number]['bands'][number]) =>
      `${percentText(b.feeBps)}${b.flatFee !== null && /[1-9]/.test(b.flatFee) ? ` + ${formatAmount(b.flatFee)} ${assetCode} flat` : ''}`;
    const stepped = winner.bands.length > 1;
    const percent = stepped ? winner.bands.map((b) => `from ${formatAmount(b.fromAmount)}: ${part(b)}`).join(', ') : part(winner.bands[0]!);
    return [{ assetCode, percent, stepped, layerWords: LAYER_WORDS[winner.layer] }];
  });
}

export const FEE_ACCOUNT_RATE = 'The fee taken at settlement is the rate on the merchant’s account, which this console does not read.';
export const FEE_NOT_CONFIGURED = 'The merchant’s own fee is set on its account; this console’s pricing rules do not include it.';
export const FEE_NO_SETTLEMENT_SNAPSHOT = 'No pricing-rule snapshot; the Fees column is what was taken.';
export const FEE_NO_CAPTURE_SNAPSHOT = 'No pricing rule applied at capture, so no snapshot was recorded.';
export const FEE_RECORDED_AT_CAPTURE = 'The pricing snapshot is written when the payment is captured.';
