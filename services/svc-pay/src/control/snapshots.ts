import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
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

/**
 * The snapshot row as stored, or null when this payment or settlement has none.
 *
 * This SELECT is the whole read. It does not call the pricing engine, so a
 * rule edited later cannot change what a merchant is shown for an old payment.
 * A row that is not a safe decimal shape is returned as null rather than a
 * recomputed fee.
 */
export interface StoredPricingSnapshot {
  readonly fee: string;
  readonly assetCode: string;
  readonly appliedLayer: 'global' | 'tier' | 'merchant';
  readonly ruleId: string;
  readonly feeBps: number;
  readonly flatFee: string | null;
  readonly spreadBps: number | null;
  readonly roundingBeneficiary: 'platform' | 'merchant';
  readonly roundingMode: 'ceil' | 'floor';
  readonly bookedFee: string | null;
  readonly reserveAmount: string | null;
  readonly recordedAt: string;
}

const LAYERS = new Set(['global', 'tier', 'merchant']);
const BENEFICIARIES = new Set(['platform', 'merchant']);
const MODES = new Set(['ceil', 'floor']);

export async function readPricingSnapshots(
  q: Sql,
  kind: 'payment' | 'settlement',
  subjectIds: readonly string[],
): Promise<Map<string, StoredPricingSnapshot>> {
  const out = new Map<string, StoredPricingSnapshot>();
  if (subjectIds.length === 0) return out;
  const rows = await q<
    Array<{
      subject_id: string;
      asset_code: string;
      applied_layer: string;
      rule_id: string;
      fee_bps: number;
      flat_fee: string | null;
      spread_bps: number | null;
      rounding_beneficiary: string;
      rounding_mode: string;
      fee: string;
      booked_fee: string | null;
      reserve_amount: string | null;
      created_at: Date;
    }>
  >`
    SELECT subject_id, asset_code, applied_layer, rule_id, fee_bps, flat_fee::text, spread_bps,
           rounding_beneficiary, rounding_mode, fee::text, booked_fee::text, reserve_amount::text, created_at
      FROM pay.control_pricing_snapshots
     WHERE subject_kind = ${kind} AND subject_id = ANY(${q.array([...subjectIds])}::uuid[])
  `;
  for (const row of rows) {
    const snap = presentSnapshot(row);
    if (snap) out.set(row.subject_id, snap);
  }
  return out;
}

function presentSnapshot(row: {
  asset_code: string;
  applied_layer: string;
  rule_id: string;
  fee_bps: number;
  flat_fee: string | null;
  spread_bps: number | null;
  rounding_beneficiary: string;
  rounding_mode: string;
  fee: string;
  booked_fee: string | null;
  reserve_amount: string | null;
  created_at: Date;
}): StoredPricingSnapshot | null {
  const fee = decimal(row.fee);
  const flatFee = row.flat_fee === null ? null : decimal(row.flat_fee);
  const bookedFee = row.booked_fee === null ? null : decimal(row.booked_fee);
  const reserveAmount = row.reserve_amount === null ? null : decimal(row.reserve_amount);
  if (
    fee === null ||
    (row.flat_fee !== null && flatFee === null) ||
    (row.booked_fee !== null && bookedFee === null) ||
    (row.reserve_amount !== null && reserveAmount === null)
  ) {
    return null;
  }
  if (!LAYERS.has(row.applied_layer) || !BENEFICIARIES.has(row.rounding_beneficiary) || !MODES.has(row.rounding_mode)) return null;
  if (!Number.isInteger(row.fee_bps) || row.fee_bps < 0 || row.fee_bps > 10_000) return null;
  if (row.spread_bps !== null && (!Number.isInteger(row.spread_bps) || row.spread_bps < 0 || row.spread_bps > 10_000)) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.rule_id)) return null;
  if (row.asset_code.length < 1 || row.asset_code.length > 16) return null;
  return {
    fee,
    assetCode: row.asset_code,
    appliedLayer: row.applied_layer as StoredPricingSnapshot['appliedLayer'],
    ruleId: row.rule_id,
    feeBps: row.fee_bps,
    flatFee,
    spreadBps: row.spread_bps,
    roundingBeneficiary: row.rounding_beneficiary as StoredPricingSnapshot['roundingBeneficiary'],
    roundingMode: row.rounding_mode as StoredPricingSnapshot['roundingMode'],
    bookedFee,
    reserveAmount,
    recordedAt: row.created_at.toISOString(),
  };
}

function decimal(raw: string): string | null {
  try {
    return formatAmount(parseAmount(raw));
  } catch {
    return null;
  }
}
