import type { Sql } from 'postgres';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import type { PricingQuote, ResolvedRule, ReserveQuote } from './pricing.js';

/** Frozen pricing for one payment or settlement. One row per subject; a second write is a no-op. */
export async function writePricingSnapshot(
  q: Sql,
  input: {
    subjectKind: 'payment' | 'settlement';
    subjectId: string;
    merchantId: string;
    assetCode: string;
    resolved: ResolvedRule;
    quote: PricingQuote;
    baseAmount: Amount;
    monthlyVolumeBefore: Amount;
    bookedFee?: Amount;
    reserve?: ReserveQuote | null;
  },
): Promise<void> {
  const { quote, resolved } = input;
  const f = formatAmount;
  await q`
    INSERT INTO pay.control_pricing_snapshots (
      subject_kind, subject_id, merchant_id, asset_code, applied_layer, rule_id, rule_chain,
      base_amount, monthly_volume_before, band_from, fee_bps, flat_fee, spread_bps,
      rounding_beneficiary, rounding_mode, bps_fee, fee_before_clamp, fee, spread, booked_fee,
      reserve_bps, reserve_hold_days, reserve_amount, reserve_release_at, reserve_ledger_status
    ) VALUES (
      ${input.subjectKind}, ${input.subjectId}, ${input.merchantId}, ${input.assetCode}, ${quote.layer}, ${quote.ruleId}, ${q.json(resolved.chain as never)},
      ${f(input.baseAmount)}::numeric, ${f(input.monthlyVolumeBefore)}::numeric, ${f(quote.bandFrom)}::numeric, ${quote.feeBps},
      ${quote.flatFee === null ? null : f(quote.flatFee)}::numeric, ${quote.spreadBps},
      ${quote.roundingBeneficiary}, ${quote.roundingMode}, ${f(quote.bpsFee)}::numeric, ${f(quote.feeBeforeClamp)}::numeric, ${f(quote.fee)}::numeric,
      ${quote.spread === null ? null : f(quote.spread)}::numeric, ${input.bookedFee === undefined ? null : f(input.bookedFee)}::numeric,
      ${input.reserve?.bps ?? null}, ${input.reserve?.holdDays ?? null}, ${input.reserve ? f(input.reserve.amount) : null}::numeric,
      ${input.reserve?.releaseAt ?? null}, ${input.reserve ? 'unwired' : null}
    )
    ON CONFLICT (subject_kind, subject_id) DO NOTHING
  `;
}
