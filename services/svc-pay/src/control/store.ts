import type { Sql } from 'postgres';
import { z } from 'zod';
import { payCapSchema, payPayoutFeeSchema, type PayCap, type PayPayoutFee } from '@intafaced/contracts';
import { parseAmount, formatAmount, type Amount } from '@intafaced/ledger-client';
import { ControlRefusal } from './errors.js';
import type { PricingBand, PricingLayer, PricingRule, RoundingBeneficiary } from './pricing.js';

/**
 * Reads of control-room configuration. Everything here is READ ONLY and
 * lock-free: configuration is consulted by guards, and the locks a guard takes
 * are on its own counter rows. A row that cannot be parsed throws
 * `pay.control_unreadable` (unavailable): unreadable config refuses, it is
 * never treated as "unset".
 */

export interface ReserveSetting {
  readonly bps: number;
  readonly holdDays: number;
}

export interface TierConfig {
  readonly id: string;
  readonly name: string;
  readonly archetype: string;
  readonly caps: readonly PayCap[];
  readonly reserve: ReserveSetting | null;
  readonly approvalThresholds: ReadonlyMap<string, Amount>;
  readonly founderThresholds: ReadonlyMap<string, Amount>;
  readonly approvalTtlSeconds: number;
  /** The payout fee the tier publishes; null = none published ("Not set"). */
  readonly payoutFee: PayPayoutFee | null;
  readonly version: bigint;
}

export interface ProfileConfig {
  readonly tierId: string | null;
  readonly archetypeId: string | null;
  readonly capsOverride: readonly PayCap[] | null;
  /** undefined = inherit the tier; null = explicitly no reserve. */
  readonly reserveOverride: ReserveSetting | null | undefined;
  readonly version: bigint;
  readonly updatedAt: Date | null;
}

export interface MerchantControl {
  readonly merchantId: string;
  readonly profile: ProfileConfig | null;
  readonly tier: TierConfig | null;
}

const capsSchema = z.array(payCapSchema);
const thresholdsSchema = z.array(z.object({ assetCode: z.string(), amount: z.string() }));
const reserveOverrideSchema = z.object({ rollingReserveBps: z.number().int().nullable(), holdDays: z.number().int().nullable() });
const bandsSchema = z.array(z.object({ fromAmount: z.string(), feeBps: z.number().int(), flatFee: z.string().nullable() }));

function unreadable(error: unknown): never {
  const refusal = new ControlRefusal('pay.control_unreadable', 'unavailable');
  Object.defineProperty(refusal, 'internal', { value: error, enumerable: false });
  throw refusal;
}

function parseOr<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) return unreadable(result.error);
  return result.data;
}

function thresholdMap(value: unknown): Map<string, Amount> {
  const map = new Map<string, Amount>();
  for (const row of parseOr(thresholdsSchema, value)) map.set(row.assetCode, parseAmount(row.amount));
  return map;
}

interface TierRow {
  id: string;
  name: string;
  archetype: string;
  caps: unknown;
  reserve_bps: number | null;
  reserve_hold_days: number | null;
  approval_thresholds: unknown;
  founder_thresholds: unknown;
  approval_ttl_seconds: number;
  /** Absent only on a row read before the payout-fee migration. */
  payout_fee?: unknown;
  version: string;
}

export function toTier(row: TierRow): TierConfig {
  return {
    id: row.id,
    name: row.name,
    archetype: row.archetype,
    caps: parseOr(capsSchema, row.caps),
    reserve: row.reserve_bps === null || row.reserve_hold_days === null ? null : { bps: row.reserve_bps, holdDays: row.reserve_hold_days },
    approvalThresholds: thresholdMap(row.approval_thresholds),
    founderThresholds: thresholdMap(row.founder_thresholds),
    approvalTtlSeconds: row.approval_ttl_seconds,
    payoutFee: row.payout_fee === null || row.payout_fee === undefined ? null : parseOr(payPayoutFeeSchema, row.payout_fee),
    version: BigInt(row.version),
  };
}

export async function loadTier(q: Sql, tierId: string): Promise<TierConfig | null> {
  const rows = await q<TierRow[]>`SELECT * FROM pay.control_tiers WHERE id = ${tierId}`;
  return rows[0] ? toTier(rows[0]) : null;
}

export async function loadMerchantControl(q: Sql, merchantId: string): Promise<MerchantControl> {
  const rows = await q<
    Array<{
      tier_id: string | null;
      archetype_id: string | null;
      caps_override: unknown;
      reserve_override: unknown;
      version: string;
      updated_at: Date | null;
    }>
  >`SELECT tier_id, archetype_id, caps_override, reserve_override, version, updated_at FROM pay.control_merchant_profiles WHERE merchant_id = ${merchantId}`;
  const row = rows[0];
  if (!row) return { merchantId, profile: null, tier: null };
  let reserveOverride: ReserveSetting | null | undefined;
  if (row.reserve_override === null || row.reserve_override === undefined) reserveOverride = undefined;
  else {
    const parsed = parseOr(reserveOverrideSchema, row.reserve_override);
    reserveOverride =
      parsed.rollingReserveBps === null || parsed.holdDays === null ? null : { bps: parsed.rollingReserveBps, holdDays: parsed.holdDays };
  }
  const profile: ProfileConfig = {
    tierId: row.tier_id,
    archetypeId: row.archetype_id,
    capsOverride: row.caps_override === null ? null : parseOr(capsSchema, row.caps_override),
    reserveOverride,
    version: BigInt(row.version),
    updatedAt: row.updated_at,
  };
  const tier = profile.tierId ? await loadTier(q, profile.tierId) : null;
  return { merchantId, profile, tier };
}

const capKey = (cap: PayCap): string => (cap.kind === 'beneficiaries_per_day' ? cap.kind : `${cap.kind}:${cap.assetCode}`);

/** Tier caps, with the merchant's overrides replacing the tier's entry of the same kind and asset. Null when no tier. */
export function effectiveCaps(control: MerchantControl): PayCap[] | null {
  if (!control.tier) return null;
  const merged = new Map<string, PayCap>();
  for (const cap of control.tier.caps) merged.set(capKey(cap), cap);
  for (const cap of control.profile?.capsOverride ?? []) merged.set(capKey(cap), cap);
  return [...merged.values()];
}

export function moneyCapLimit(
  caps: readonly PayCap[],
  kind: 'per_payment' | 'daily_intake' | 'monthly_intake' | 'daily_payout',
  assetCode: string,
): Amount | null {
  for (const cap of caps) if (cap.kind === kind && cap.assetCode === assetCode) return parseAmount(cap.limit);
  return null;
}

export function countCapLimit(caps: readonly PayCap[]): number | null {
  for (const cap of caps) if (cap.kind === 'beneficiaries_per_day') return cap.limit;
  return null;
}

export function effectiveReserve(control: MerchantControl): ReserveSetting | null {
  const override = control.profile?.reserveOverride;
  if (override !== undefined) return override;
  return control.tier?.reserve ?? null;
}

interface RuleRow {
  id: string;
  layer: PricingLayer;
  scope_id: string;
  asset_code: string;
  bands: unknown;
  spread_bps: number | null;
  rounding_beneficiary: RoundingBeneficiary;
  min_fee: string | null;
  max_fee: string | null;
  version: string;
  created_at?: Date;
}

export function toRule(row: RuleRow): PricingRule {
  const bands: PricingBand[] = parseOr(bandsSchema, row.bands).map((b) => ({
    fromAmount: parseAmount(b.fromAmount),
    feeBps: b.feeBps,
    flatFee: b.flatFee === null ? null : parseAmount(b.flatFee),
  }));
  return {
    id: row.id,
    layer: row.layer,
    scopeId: row.scope_id,
    assetCode: row.asset_code,
    bands,
    spreadBps: row.spread_bps,
    roundingBeneficiary: row.rounding_beneficiary,
    minFee: row.min_fee === null ? null : parseAmount(row.min_fee),
    maxFee: row.max_fee === null ? null : parseAmount(row.max_fee),
    version: BigInt(row.version),
  };
}

/** Live rules that could apply to this merchant and asset, one per layer at most. */
export async function loadApplicableRules(q: Sql, merchantId: string, tierId: string | null, assetCode: string): Promise<PricingRule[]> {
  const rows = await q<RuleRow[]>`
    SELECT * FROM pay.control_pricing_rules
     WHERE superseded_at IS NULL AND asset_code = ${assetCode}
       AND ((layer = 'global' AND scope_id = '')
         OR (layer = 'tier' AND scope_id = ${tierId ?? ''})
         OR (layer = 'merchant' AND scope_id = ${merchantId}))
  `;
  return rows.map(toRule);
}

// ── periods ─────────────────────────────────────────────────────────────────

export const dayKey = (at: Date): string => at.toISOString().slice(0, 10);
export const monthKey = (at: Date): string => at.toISOString().slice(0, 7);
export const nextDayStart = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
export const nextMonthStart = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

/** Month-to-date intake for the pricing band. Read-only; missing row = 0. */
export async function monthlyIntake(q: Sql, merchantId: string, assetCode: string, at: Date): Promise<Amount> {
  const rows = await q<Array<{ used: string }>>`
    SELECT used FROM pay.control_cap_usage
     WHERE merchant_id = ${merchantId} AND cap_kind = 'monthly_intake' AND asset_code = ${assetCode} AND period_key = ${monthKey(at)}
  `;
  return rows[0] ? parseAmount(rows[0].used) : 0n;
}

export const money = { parse: parseAmount, format: formatAmount };
