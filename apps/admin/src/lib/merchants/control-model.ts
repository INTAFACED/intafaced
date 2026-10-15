import type { MerchantControlProfile, PayCap, PayPricingRule } from '@intafaced/contracts';
import { compareDecimal, formatAmount, isDecimalString, permille } from './money';

/**
 * Merchant control room (svc-pay `founderAdmin.control.*`, `founderAdmin.changes.*`).
 *
 * The profile, approval and halt shapes come from `@intafaced/contracts`. The tier, pricing-rule and usage
 * views live in svc-pay (`control/schemas.ts`) and are not published yet, so their shapes are mirrored here
 * by hand and parsed strictly: anything that is not exactly that shape reads as "invalid" and the page says
 * so, never a half-filled table. The service validates every change again; the rules below only give the
 * founder an answer before the round trip, in plain English.
 *
 * Nothing in this file carries a commercial number. Forms start empty; an unset section is "not configured:
 * payments refuse", never a placeholder.
 */

// ── views the service returns that the contract package does not publish ────

export interface Threshold {
  readonly assetCode: string;
  readonly amount: string;
}

export interface TierView {
  readonly id: string;
  readonly name: string;
  readonly archetype: string;
  readonly caps: PayCap[];
  readonly reserve: { rollingReserveBps: number | null; holdDays: number | null } | null;
  readonly approvalThresholds: Threshold[];
  readonly founderThresholds: Threshold[];
  readonly approvalTtlSeconds: number;
  readonly version: string;
  readonly merchants: number;
}

export interface PricingRuleView {
  readonly ruleId: string;
  readonly layer: 'global' | 'tier' | 'merchant';
  readonly scopeId: string | null;
  readonly assetCode: string;
  readonly bands: { fromAmount: string; feeBps: number; flatFee: string | null }[];
  readonly spreadBps: number | null;
  readonly roundingBeneficiary: 'platform' | 'merchant';
  readonly minFee: string | null;
  readonly maxFee: string | null;
  readonly version: string;
  readonly createdAt: string;
}

export interface UsageRow {
  readonly kind: CapKind;
  readonly assetCode: string | null;
  readonly limit: string;
  readonly used: string | null;
  readonly remaining: string | null;
  readonly resetsAt: string | null;
}
export interface UsageView {
  readonly merchantId: string;
  readonly tierId: string | null;
  readonly asOf: string;
  readonly rows: UsageRow[];
}

export const CAP_KINDS = ['per_payment', 'daily_intake', 'monthly_intake', 'daily_payout', 'beneficiaries_per_day'] as const;
export type CapKind = (typeof CAP_KINDS)[number];
const MONEY_CAP_KINDS = ['per_payment', 'daily_intake', 'monthly_intake', 'daily_payout'] as const;

export const CAP_LABEL: Record<CapKind, string> = {
  per_payment: 'Largest single payment',
  daily_intake: 'Money in per day',
  monthly_intake: 'Money in per month',
  daily_payout: 'Payouts per day',
  beneficiaries_per_day: 'New payout destinations per day',
};
export const CAP_HINT: Record<CapKind, string> = {
  per_payment: 'A payment above this is refused at checkout.',
  daily_intake: 'Captured payments in one UTC day. When it is used up, new payments are refused until midnight UTC.',
  monthly_intake: 'Captured payments in one UTC month. When it is used up, new payments are refused until the 1st.',
  daily_payout: 'Money paid out in one UTC day.',
  beneficiaries_per_day: 'How many different payout destinations can receive money in one UTC day.',
};

// ── strict readers ──────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNullableStr = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isBps = (v: unknown): v is number => isInt(v) && v >= 0 && v <= 10_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isIso = (v: unknown): v is string => isStr(v) && ISO.test(v) && Number.isFinite(Date.parse(v));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLUG = /^[a-z][a-z0-9_-]{1,31}$/;
const isDec = (v: unknown): v is string => isDecimalString(v);

function listOf<T>(raw: unknown, each: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const item of raw) {
    const parsed = each(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

export function asCap(raw: unknown): PayCap | null {
  if (!isRec(raw)) return null;
  if (raw.kind === 'beneficiaries_per_day') {
    const keys = Object.keys(raw).sort().join(',');
    return keys === 'kind,limit' && isInt(raw.limit) && raw.limit >= 0 && raw.limit <= 1_000_000
      ? { kind: 'beneficiaries_per_day', limit: raw.limit }
      : null;
  }
  const kind = MONEY_CAP_KINDS.find((k) => k === raw.kind);
  if (!kind || Object.keys(raw).sort().join(',') !== 'assetCode,kind,limit') return null;
  return isStr(raw.assetCode) && raw.assetCode.length >= 1 && raw.assetCode.length <= 16 && isDec(raw.limit)
    ? { kind, assetCode: raw.assetCode, limit: raw.limit }
    : null;
}

function asThreshold(raw: unknown): Threshold | null {
  return isRec(raw) && isStr(raw.assetCode) && isDec(raw.amount) ? { assetCode: raw.assetCode, amount: raw.amount } : null;
}

function asReserve(raw: unknown): TierView['reserve'] | undefined {
  if (raw === null) return null;
  if (!isRec(raw)) return undefined;
  const bps = raw.rollingReserveBps;
  const days = raw.holdDays;
  if (!(bps === null || isBps(bps)) || !(days === null || (isInt(days) && days >= 0 && days <= 365))) return undefined;
  return { rollingReserveBps: bps, holdDays: days };
}

export function asTier(raw: unknown): TierView | null {
  if (!isRec(raw)) return null;
  const caps = listOf(raw.caps, asCap);
  const approvalThresholds = listOf(raw.approvalThresholds, asThreshold);
  const founderThresholds = listOf(raw.founderThresholds, asThreshold);
  const reserve = asReserve(raw.reserve);
  if (
    !isStr(raw.id) ||
    !isStr(raw.name) ||
    !isStr(raw.archetype) ||
    !caps ||
    !approvalThresholds ||
    !founderThresholds ||
    reserve === undefined ||
    !isInt(raw.approvalTtlSeconds) ||
    !isStr(raw.version) ||
    !isInt(raw.merchants)
  )
    return null;
  return {
    id: raw.id,
    name: raw.name,
    archetype: raw.archetype,
    caps,
    reserve,
    approvalThresholds,
    founderThresholds,
    approvalTtlSeconds: raw.approvalTtlSeconds,
    version: raw.version,
    merchants: raw.merchants,
  };
}

function asBand(raw: unknown): PricingRuleView['bands'][number] | null {
  return isRec(raw) && isDec(raw.fromAmount) && isBps(raw.feeBps) && (raw.flatFee === null || isDec(raw.flatFee))
    ? { fromAmount: raw.fromAmount, feeBps: raw.feeBps, flatFee: raw.flatFee as string | null }
    : null;
}

export function asPricingRule(raw: unknown): PricingRuleView | null {
  if (!isRec(raw)) return null;
  const bands = listOf(raw.bands, asBand);
  const layer = raw.layer === 'global' || raw.layer === 'tier' || raw.layer === 'merchant' ? raw.layer : null;
  const minFee = raw.minFee === undefined ? null : raw.minFee;
  const maxFee = raw.maxFee === undefined ? null : raw.maxFee;
  if (
    !bands ||
    bands.length === 0 ||
    !layer ||
    !isStr(raw.ruleId) ||
    !isNullableStr(raw.scopeId) ||
    !isStr(raw.assetCode) ||
    !(raw.spreadBps === null || isBps(raw.spreadBps)) ||
    !(raw.roundingBeneficiary === 'platform' || raw.roundingBeneficiary === 'merchant') ||
    !(minFee === null || isDec(minFee)) ||
    !(maxFee === null || isDec(maxFee)) ||
    !isStr(raw.version) ||
    !isIso(raw.createdAt)
  )
    return null;
  return {
    ruleId: raw.ruleId,
    layer,
    scopeId: raw.scopeId,
    assetCode: raw.assetCode,
    bands,
    spreadBps: raw.spreadBps,
    roundingBeneficiary: raw.roundingBeneficiary,
    minFee,
    maxFee,
    version: raw.version,
    createdAt: raw.createdAt,
  };
}

function asUsageRow(raw: unknown): UsageRow | null {
  const kind = isRec(raw) ? CAP_KINDS.find((k) => k === raw.kind) : undefined;
  if (!isRec(raw) || !kind) return null;
  if (!(raw.assetCode === null || isStr(raw.assetCode)) || !isStr(raw.limit) || !isNullableStr(raw.used) || !isNullableStr(raw.remaining))
    return null;
  if (!(raw.resetsAt === null || isIso(raw.resetsAt))) return null;
  return { kind, assetCode: raw.assetCode, limit: raw.limit, used: raw.used, remaining: raw.remaining, resetsAt: raw.resetsAt };
}

export function asUsage(raw: unknown): UsageView | null {
  if (!isRec(raw)) return null;
  const rows = listOf(raw.rows, asUsageRow);
  if (!rows || !isStr(raw.merchantId) || !UUID.test(raw.merchantId) || !isNullableStr(raw.tierId) || !isIso(raw.asOf)) return null;
  return { merchantId: raw.merchantId, tierId: raw.tierId, asOf: raw.asOf, rows };
}

// ── describing values in words ──────────────────────────────────────────────

/** 150 -> "1.50% (150 bps)". Integer arithmetic only. */
export function bpsText(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}% (${bps} bps)`;
}

export function ttlText(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

export function capLimitText(cap: PayCap): string {
  return cap.kind === 'beneficiaries_per_day' ? String(cap.limit) : `${formatAmount(cap.limit)} ${cap.assetCode}`;
}

export const LAYER_LABEL: Record<PricingRuleView['layer'], string> = { global: 'Global', tier: 'Tier', merchant: 'This merchant' };
export const LAYER_RANK: Record<PricingRuleView['layer'], number> = { merchant: 3, tier: 2, global: 1 };

export interface UsageMeter {
  /** 0 to 1000, for the bar width only. Null when usage is not measured (a per-payment cap has no counter). */
  readonly permille: number | null;
  readonly state: 'unmeasured' | 'ok' | 'near' | 'full';
}

/** "Near" is a display label at 80% used; it gates nothing. */
export function usageMeter(row: Pick<UsageRow, 'limit' | 'used'>): UsageMeter {
  if (row.used === null || !isDec(row.used) || !isDec(row.limit)) return { permille: null, state: 'unmeasured' };
  if (compareDecimal(row.limit, '0') === 0) return { permille: 1000, state: 'full' };
  const p = permille(row.used, row.limit);
  return { permille: p, state: p >= 1000 ? 'full' : p >= 800 ? 'near' : 'ok' };
}

export interface PricingChainRow {
  readonly assetCode: string;
  /** Every layer that has a rule for this asset, most specific first. The first one is the one in force. */
  readonly layers: { rule: PricingRuleView; inForce: boolean }[];
}

/** Group the three layers' rules by asset. The most specific layer with a rule for an asset wins (merchant, then tier, then global). */
export function pricingChain(rules: readonly PricingRuleView[]): PricingChainRow[] {
  const assets = [...new Set(rules.map((r) => r.assetCode))].sort();
  return assets.map((assetCode) => {
    const layers = rules
      .filter((r) => r.assetCode === assetCode)
      .sort((a, b) => LAYER_RANK[b.layer] - LAYER_RANK[a.layer])
      .map((rule, i) => ({ rule, inForce: i === 0 }));
    return { assetCode, layers };
  });
}

// ── the change form ─────────────────────────────────────────────────────────

export const CHANGE_KINDS = [
  {
    id: 'set_tier',
    label: 'Tier',
    hint: 'Which tier this merchant is on. The tier brings its caps, thresholds and reserve unless overridden.',
  },
  {
    id: 'set_caps',
    label: 'Caps',
    hint: 'This merchant’s own caps. Each kind you list replaces the tier’s cap of that kind; kinds you leave out keep the tier’s. A merchant needs a tier first.',
  },
  {
    id: 'set_pricing',
    label: 'Pricing',
    hint: 'This merchant’s own fee rule per asset. It is the most specific layer and wins over tier and global.',
  },
  { id: 'set_reserve', label: 'Reserve', hint: 'Money withheld from settlement for a number of days.' },
] as const;
export type ChangeKindId = (typeof CHANGE_KINDS)[number]['id'];

export interface CapRow {
  kind: CapKind | '';
  assetCode: string;
  limit: string;
}
export interface BandRow {
  fromAmount: string;
  feeBps: string;
  flatFee: string;
}
export interface ChangeFormValues {
  kind: ChangeKindId;
  tierId: string;
  archetypeId: string;
  caps: CapRow[];
  reserveBps: string;
  holdDays: string;
  pricingAsset: string;
  pricingSpread: string;
  pricingRounding: '' | 'platform' | 'merchant';
  bands: BandRow[];
  reason: string;
}

export const EMPTY_CAP: CapRow = { kind: '', assetCode: '', limit: '' };
export const EMPTY_BAND: BandRow = { fromAmount: '', feeBps: '', flatFee: '' };

export const EMPTY_CHANGE_FORM: ChangeFormValues = {
  kind: 'set_tier',
  tierId: '',
  archetypeId: '',
  caps: [{ ...EMPTY_CAP }],
  reserveBps: '',
  holdDays: '',
  pricingAsset: '',
  pricingSpread: '',
  pricingRounding: '',
  bands: [{ ...EMPTY_BAND }],
  reason: '',
};

/** The change as the service takes it. */
export type ControlChange =
  | { kind: 'set_tier'; tierId: string; archetypeId: string | null }
  | { kind: 'set_caps'; caps: PayCap[] }
  | { kind: 'set_pricing'; pricing: PayPricingRule[] }
  | { kind: 'set_reserve'; reserve: { rollingReserveBps: number | null; holdDays: number | null } };

export type ChangeErrors = Record<string, string>;
export type BuildChangeResult = { ok: true; change: ControlChange; reason: string } | { ok: false; errors: ChangeErrors };

const INT = /^\d+$/;
const REASON_MIN = 3;
const REASON_MAX = 500;

export function validateReason(reason: string): string | null {
  const t = reason.trim();
  if (t.length < REASON_MIN) return `Write at least ${REASON_MIN} characters: why is this change being made?`;
  if (t.length > REASON_MAX) return `Keep the reason under ${REASON_MAX} characters.`;
  return null;
}

export function buildControlChange(v: ChangeFormValues, merchantId: string): BuildChangeResult {
  const errors: ChangeErrors = {};
  let change: ControlChange | null = null;
  const reasonError = validateReason(v.reason);
  if (reasonError) errors.reason = reasonError;

  if (v.kind === 'set_tier') {
    if (!SLUG.test(v.tierId)) errors.tierId = 'Pick a tier from the list.';
    const archetype = v.archetypeId.trim();
    if (archetype !== '' && !SLUG.test(archetype))
      errors.archetypeId = 'Use lowercase letters, digits, dashes or underscores, 2 to 32 characters. Or leave it empty.';
    if (!errors.tierId && !errors.archetypeId)
      change = { kind: 'set_tier', tierId: v.tierId, archetypeId: archetype === '' ? null : archetype };
  } else if (v.kind === 'set_caps') {
    const caps: PayCap[] = [];
    const seen = new Set<string>();
    if (v.caps.length === 0) errors.caps = 'Add at least one cap.';
    v.caps.forEach((row, i) => {
      if (row.kind === '') {
        errors[`caps.${i}.kind`] = 'Choose what this cap limits.';
        return;
      }
      if (row.kind === 'beneficiaries_per_day') {
        if (!INT.test(row.limit.trim()) || Number(row.limit) > 1_000_000) {
          errors[`caps.${i}.limit`] = 'Enter a whole number from 0 to 1,000,000.';
          return;
        }
        if (seen.has(row.kind)) errors[`caps.${i}.kind`] = 'This cap is listed twice.';
        seen.add(row.kind);
        caps.push({ kind: 'beneficiaries_per_day', limit: Number(row.limit) });
        return;
      }
      const asset = row.assetCode.trim().toUpperCase();
      if (asset.length < 1 || asset.length > 16)
        errors[`caps.${i}.assetCode`] = 'Enter the asset code, for example the asset the cap is counted in.';
      if (!isDec(row.limit.trim()))
        errors[`caps.${i}.limit`] = 'Enter an amount like 1000 or 1000.50 (digits and one dot, up to 18 places).';
      const key = `${row.kind}:${asset}`;
      if (seen.has(key)) errors[`caps.${i}.kind`] = 'This cap is listed twice for the same asset.';
      seen.add(key);
      if (!errors[`caps.${i}.assetCode`] && !errors[`caps.${i}.limit`])
        caps.push({ kind: row.kind, assetCode: asset, limit: row.limit.trim() });
    });
    if (v.caps.length > 32) errors.caps = 'At most 32 caps.';
    if (Object.keys(errors).filter((k) => k.startsWith('caps')).length === 0) change = { kind: 'set_caps', caps };
  } else if (v.kind === 'set_reserve') {
    const bps = v.reserveBps.trim();
    const days = v.holdDays.trim();
    if (bps !== '' && (!INT.test(bps) || Number(bps) > 10_000))
      errors.reserveBps = 'Enter whole basis points from 0 to 10,000 (100 bps is 1%).';
    if (days !== '' && (!INT.test(days) || Number(days) > 365)) errors.holdDays = 'Enter whole days from 0 to 365.';
    if ((bps === '') !== (days === '') && !errors.reserveBps && !errors.holdDays) {
      errors[bps === '' ? 'reserveBps' : 'holdDays'] = 'A reserve needs both a percentage and a hold period, or neither.';
    }
    if (!errors.reserveBps && !errors.holdDays) {
      change = {
        kind: 'set_reserve',
        reserve: bps === '' ? { rollingReserveBps: null, holdDays: null } : { rollingReserveBps: Number(bps), holdDays: Number(days) },
      };
    }
  } else {
    const asset = v.pricingAsset.trim().toUpperCase();
    if (asset.length < 1 || asset.length > 16) errors.pricingAsset = 'Enter the asset code this rule prices.';
    const spread = v.pricingSpread.trim();
    if (spread !== '' && (!INT.test(spread) || Number(spread) > 10_000))
      errors.pricingSpread = 'Enter whole basis points from 0 to 10,000, or leave empty for no spread.';
    if (v.pricingRounding === '') errors.pricingRounding = 'Choose who keeps the fraction when a fee does not divide evenly.';
    const bands: PayPricingRule['bands'] = [];
    if (v.bands.length === 0 || v.bands.length > 64) errors.bands = 'A rule needs between 1 and 64 bands.';
    v.bands.forEach((b, i) => {
      if (!isDec(b.fromAmount.trim())) errors[`bands.${i}.fromAmount`] = 'Enter the amount this band starts at, like 0 or 1000.';
      if (!INT.test(b.feeBps.trim()) || Number(b.feeBps) > 10_000)
        errors[`bands.${i}.feeBps`] = 'Enter whole basis points from 0 to 10,000.';
      if (b.flatFee.trim() !== '' && !isDec(b.flatFee.trim()))
        errors[`bands.${i}.flatFee`] = 'Enter an amount like 0.30, or leave empty for no flat fee.';
      if (!errors[`bands.${i}.fromAmount`] && !errors[`bands.${i}.feeBps`] && !errors[`bands.${i}.flatFee`]) {
        const prev = bands[i - 1];
        if (prev && compareDecimal(prev.fromAmount, b.fromAmount.trim()) >= 0)
          errors[`bands.${i}.fromAmount`] = 'Each band must start higher than the one before.';
        bands.push({
          fromAmount: b.fromAmount.trim(),
          feeBps: Number(b.feeBps),
          flatFee: b.flatFee.trim() === '' ? null : b.flatFee.trim(),
        });
      }
    });
    if (Object.keys(errors).filter((k) => k.startsWith('pricing') || k.startsWith('bands')).length === 0 && v.pricingRounding !== '') {
      change = {
        kind: 'set_pricing',
        pricing: [
          {
            layer: 'merchant',
            scopeId: merchantId,
            assetCode: asset,
            bands,
            spreadBps: spread === '' ? null : Number(spread),
            roundingBeneficiary: v.pricingRounding,
          },
        ],
      };
    }
  }
  return change && Object.keys(errors).length === 0 ? { ok: true, change, reason: v.reason.trim() } : { ok: false, errors };
}

// ── strict reader for a change that travels as text (the second founder's paste) ──

export function acceptControlChange(raw: unknown, merchantId: string): ControlChange | null {
  if (!isRec(raw)) return null;
  if (raw.kind === 'set_tier') {
    return Object.keys(raw).sort().join(',') === 'archetypeId,kind,tierId' &&
      isStr(raw.tierId) &&
      SLUG.test(raw.tierId) &&
      (raw.archetypeId === null || (isStr(raw.archetypeId) && SLUG.test(raw.archetypeId)))
      ? { kind: 'set_tier', tierId: raw.tierId, archetypeId: raw.archetypeId }
      : null;
  }
  if (raw.kind === 'set_caps') {
    const caps = Object.keys(raw).sort().join(',') === 'caps,kind' ? listOf(raw.caps, asCap) : null;
    return caps && caps.length >= 1 && caps.length <= 32 ? { kind: 'set_caps', caps } : null;
  }
  if (raw.kind === 'set_reserve') {
    const reserve = Object.keys(raw).sort().join(',') === 'kind,reserve' ? asReserve(raw.reserve) : undefined;
    // A reserve is a percentage AND a hold period, or neither: the same rule the form and the service apply.
    return reserve && (reserve.rollingReserveBps === null) === (reserve.holdDays === null) ? { kind: 'set_reserve', reserve } : null;
  }
  if (raw.kind === 'set_pricing' && Object.keys(raw).sort().join(',') === 'kind,pricing') {
    const rules = listOf(raw.pricing, (r): PayPricingRule | null => {
      if (!isRec(r) || Object.keys(r).sort().join(',') !== 'assetCode,bands,layer,roundingBeneficiary,scopeId,spreadBps') return null;
      const bands = listOf(r.bands, asBand);
      if (
        !bands ||
        bands.length === 0 ||
        r.layer !== 'merchant' ||
        r.scopeId !== merchantId ||
        !isStr(r.assetCode) ||
        r.assetCode.length < 1 ||
        r.assetCode.length > 16 ||
        !(r.spreadBps === null || isBps(r.spreadBps)) ||
        !(r.roundingBeneficiary === 'platform' || r.roundingBeneficiary === 'merchant')
      )
        return null;
      return {
        layer: 'merchant',
        scopeId: merchantId,
        assetCode: r.assetCode,
        bands,
        spreadBps: r.spreadBps,
        roundingBeneficiary: r.roundingBeneficiary,
      };
    });
    return rules && rules.length >= 1 && rules.length <= 32 ? { kind: 'set_pricing', pricing: rules } : null;
  }
  return null;
}

// ── the change in words ─────────────────────────────────────────────────────

export interface SummaryLine {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export function summariseControlChange(change: ControlChange, tiers: readonly TierView[] = []): SummaryLine[] {
  if (change.kind === 'set_tier') {
    const tier = tiers.find((t) => t.id === change.tierId);
    return [
      { key: 'tier', label: 'Tier', value: tier ? `${tier.name} (${tier.id})` : change.tierId },
      { key: 'archetype', label: 'Archetype', value: change.archetypeId ?? 'The tier’s own' },
    ];
  }
  if (change.kind === 'set_caps') {
    return [
      {
        key: 'replaces',
        label: 'Effect',
        value:
          'Each kind listed replaces the tier’s cap of that kind for this merchant; kinds not listed keep the tier’s. Has no effect until the merchant has a tier.',
      },
      ...change.caps.map((cap, i) => ({
        key: `cap${i}`,
        label: CAP_LABEL[cap.kind] + (cap.kind === 'beneficiaries_per_day' ? '' : ` (${cap.assetCode})`),
        value: capLimitText(cap),
      })),
    ];
  }
  if (change.kind === 'set_reserve') {
    const { rollingReserveBps: bps, holdDays: days } = change.reserve;
    return bps === null || days === null
      ? [{ key: 'reserve', label: 'Reserve', value: 'None. No money is withheld from settlement.' }]
      : [
          { key: 'bps', label: 'Withheld', value: bpsText(bps) },
          { key: 'days', label: 'Held for', value: `${days} day${days === 1 ? '' : 's'}` },
        ];
  }
  return change.pricing.flatMap((rule, i): SummaryLine[] => [
    { key: `asset${i}`, label: 'Asset', value: `${rule.assetCode}, this merchant’s own rule` },
    ...rule.bands.map((b, j) => ({
      key: `band${i}.${j}`,
      label: `From ${formatAmount(b.fromAmount)}`,
      value: `${bpsText(b.feeBps)}${b.flatFee === null ? '' : ` + ${formatAmount(b.flatFee)} flat`}`,
    })),
    { key: `spread${i}`, label: 'Conversion spread', value: rule.spreadBps === null ? 'None' : bpsText(rule.spreadBps) },
    { key: `round${i}`, label: 'Fraction kept by', value: rule.roundingBeneficiary === 'platform' ? 'The platform' : 'The merchant' },
  ]);
}

/** Starting values for the form: the merchant's own current numbers where there are any, never an invented default. */
export function formFromProfile(profile: MerchantControlProfile | null, merchantRules: readonly PricingRuleView[]): ChangeFormValues {
  const base: ChangeFormValues = { ...EMPTY_CHANGE_FORM, caps: [{ ...EMPTY_CAP }], bands: [{ ...EMPTY_BAND }] };
  if (!profile) return base;
  const rule = merchantRules[0];
  return {
    ...base,
    tierId: profile.tierId ?? '',
    archetypeId: profile.archetypeId ?? '',
    caps: profile.caps && profile.caps.length > 0 ? profile.caps.map(capToRow) : base.caps,
    reserveBps:
      profile.reserve?.rollingReserveBps === null || profile.reserve?.rollingReserveBps === undefined
        ? ''
        : String(profile.reserve.rollingReserveBps),
    holdDays: profile.reserve?.holdDays === null || profile.reserve?.holdDays === undefined ? '' : String(profile.reserve.holdDays),
    ...(rule
      ? {
          pricingAsset: rule.assetCode,
          pricingSpread: rule.spreadBps === null ? '' : String(rule.spreadBps),
          pricingRounding: rule.roundingBeneficiary,
          bands: rule.bands.map((b) => ({ fromAmount: b.fromAmount, feeBps: String(b.feeBps), flatFee: b.flatFee ?? '' })),
        }
      : {}),
  };
}

function capToRow(cap: PayCap): CapRow {
  return cap.kind === 'beneficiaries_per_day'
    ? { kind: cap.kind, assetCode: '', limit: String(cap.limit) }
    : { kind: cap.kind, assetCode: cap.assetCode, limit: cap.limit };
}

// ── hand-off between the two founders ───────────────────────────────────────

export interface Handoff {
  readonly requestId: string;
  readonly merchantId: string;
  readonly expectedVersion: string;
  readonly change: ControlChange;
  readonly reason: string;
}

export function makeHandoff(h: Handoff): string {
  return JSON.stringify({ v: 1, ...h });
}

export function parseHandoff(text: string): Handoff | null {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isRec(raw) || raw.v !== 1) return null;
    if (!isStr(raw.requestId) || !UUID.test(raw.requestId) || !isStr(raw.merchantId) || !UUID.test(raw.merchantId)) return null;
    if (!isStr(raw.expectedVersion) || !/^(?:0|[1-9]\d{0,39})$/.test(raw.expectedVersion) || !isStr(raw.reason)) return null;
    // The reason is read by the second founder: bounded like the service bounds it, never an unlimited block of text.
    if (validateReason(raw.reason) !== null || raw.reason.trim() !== raw.reason) return null;
    const change = acceptControlChange(raw.change, raw.merchantId.toLowerCase());
    return change
      ? {
          requestId: raw.requestId.toLowerCase(),
          merchantId: raw.merchantId.toLowerCase(),
          expectedVersion: raw.expectedVersion,
          change,
          reason: raw.reason,
        }
      : null;
  } catch {
    return null;
  }
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    isRec(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );

/** Is this the same change, for the same reason, as the one a request reference was already issued for? */
export function isSameChange(a: { change: ControlChange; reason: string } | null, b: { change: ControlChange; reason: string }): boolean {
  return a !== null && a.reason === b.reason && stable(a.change) === stable(b.change);
}

const sortRules = <T extends { assetCode: string }>(list: readonly T[]) =>
  [...list].sort((a, b) => (a.assetCode < b.assetCode ? -1 : a.assetCode > b.assetCode ? 1 : 0));

// ── comparing what the service reports with what a change should produce ────
// Amounts are compared by VALUE (the service re-formats them: "0.30" comes back as "0.3"), never as strings.

const amountEq = (a: string, b: string): boolean => (isDec(a) && isDec(b) ? compareDecimal(a, b) === 0 : a === b);
const capKey = (c: PayCap): string => (c.kind === 'beneficiaries_per_day' ? c.kind : `${c.kind}:${c.assetCode}`);
const capEq = (a: PayCap, b: PayCap): boolean =>
  a.kind === 'beneficiaries_per_day'
    ? b.kind === 'beneficiaries_per_day' && a.limit === b.limit
    : b.kind !== 'beneficiaries_per_day' && a.kind === b.kind && a.assetCode === b.assetCode && amountEq(a.limit, b.limit);

type CapMap = Map<string, PayCap>;
const capMap = (list: readonly PayCap[]): CapMap => new Map(list.map((c) => [capKey(c), c]));
/** svc-pay `effectiveCaps`: the tier's caps, each replaced by the merchant's own entry of the same kind and asset. */
const mergeCaps = (tierCaps: readonly PayCap[], override: readonly PayCap[]): CapMap => {
  const merged = capMap(tierCaps);
  for (const c of override) merged.set(capKey(c), c);
  return merged;
};
const capMapEq = (a: CapMap | null, b: CapMap | null): boolean =>
  a === null || b === null ? a === b : a.size === b.size && [...a].every(([k, c]) => b.has(k) && capEq(c, b.get(k)!));

const reserveEq = (
  a: { rollingReserveBps: number | null; holdDays: number | null } | null,
  b: { rollingReserveBps: number | null; holdDays: number | null } | null,
): boolean => (a === null || b === null ? a === b : a.rollingReserveBps === b.rollingReserveBps && a.holdDays === b.holdDays);
const NO_RESERVE = { rollingReserveBps: null, holdDays: null };

const ruleEq = (a: PayPricingRule, b: PayPricingRule): boolean =>
  a.layer === b.layer &&
  a.scopeId === b.scopeId &&
  a.assetCode === b.assetCode &&
  a.spreadBps === b.spreadBps &&
  a.roundingBeneficiary === b.roundingBeneficiary &&
  a.bands.length === b.bands.length &&
  a.bands.every(
    (x, i) =>
      amountEq(x.fromAmount, b.bands[i]!.fromAmount) &&
      x.feeBps === b.bands[i]!.feeBps &&
      (x.flatFee === null || b.bands[i]!.flatFee === null ? x.flatFee === b.bands[i]!.flatFee : amountEq(x.flatFee, b.bands[i]!.flatFee!)),
  );
const rulesEq = (a: readonly PayPricingRule[] | null, b: readonly PayPricingRule[] | null): boolean => {
  if (a === null || b === null) return a === b;
  const x = sortRules(a);
  const y = sortRules(b);
  return x.length === y.length && x.every((r, i) => ruleEq(r, y[i]!));
};
const merchantLayer = (p: MerchantControlProfile): PayPricingRule[] => (p.pricing ?? []).filter((r) => r.layer === 'merchant');

/**
 * After a confirm, does what the service reports hold exactly the change the second founder was shown, and nothing else?
 *
 * The second founder reads the change from a pasted request, so this is a check on the service's answer, on top of the
 * service refusing a confirm whose hash differs. It models the service exactly: same merchant and request, the version
 * advanced once, and every section equal to what it was or to what the change sets. Caps are the tier's caps merged per
 * kind with the merchant's own (svc-pay `effectiveCaps`), so a partial override keeps the tier's other kinds. Amounts compare by value.
 *
 * `tiers` are the tier definitions this page was loaded with. If a tier was edited since, the expectation is off: the
 * caller asks `relevantTiersChanged` before calling a failure an incident.
 */
export function verifyConfirmResult(input: {
  handoff: Handoff;
  pageMerchantId: string;
  before: MerchantControlProfile;
  tiers: readonly TierView[];
  result: { requestId: string; merchantId: string; profile: MerchantControlProfile | null };
}): boolean {
  const { handoff, pageMerchantId, before, tiers, result } = input;
  const page = pageMerchantId.toLowerCase();
  const after = result.profile;
  if (!after) return false;
  if (result.requestId.toLowerCase() !== handoff.requestId) return false;
  if (result.merchantId.toLowerCase() !== page || handoff.merchantId !== page) return false;
  if (before.merchantId.toLowerCase() !== page || after.merchantId.toLowerCase() !== page) return false;
  if (handoff.expectedVersion !== before.version) return false;
  if (after.version !== String(BigInt(before.version) + 1n)) return false;
  const { change } = handoff;
  const beforeCaps = before.caps && capMap(before.caps);
  const afterCaps = after.caps && capMap(after.caps);
  const unchanged = {
    tier: after.tierId === before.tierId,
    archetype: after.archetypeId === before.archetypeId,
    caps: capMapEq(afterCaps, beforeCaps),
    reserve: reserveEq(after.reserve, before.reserve),
    pricing: rulesEq(after.pricing, before.pricing),
  };

  if (change.kind === 'set_caps') {
    // The service refuses caps for a merchant with no tier, so a confirm for one cannot have happened.
    const tier = tiers.find((t) => t.id === before.tierId);
    if (!tier) return false;
    return (
      unchanged.tier &&
      unchanged.archetype &&
      unchanged.reserve &&
      unchanged.pricing &&
      capMapEq(afterCaps, mergeCaps(tier.caps, change.caps))
    );
  }
  if (change.kind === 'set_reserve') {
    return unchanged.tier && unchanged.archetype && unchanged.caps && unchanged.pricing && reserveEq(after.reserve, change.reserve);
  }
  if (change.kind === 'set_pricing') {
    const assets = new Set(change.pricing.map((r) => r.assetCode));
    const wantPricing = [...(before.pricing ?? []).filter((r) => !assets.has(r.assetCode)), ...change.pricing];
    return unchanged.tier && unchanged.archetype && unchanged.caps && unchanged.reserve && rulesEq(after.pricing, wantPricing);
  }

  // set_tier: the archetype is the one asked for or, when none was, the new tier's own.
  const next = tiers.find((t) => t.id === change.tierId);
  if (!next) return false;
  if (after.tierId !== change.tierId || after.archetypeId !== (change.archetypeId ?? next.archetype)) return false;
  // This merchant's own entries (not visible as such in the profile) carry over to the new tier.
  const old = before.tierId === null ? null : (tiers.find((t) => t.id === before.tierId) ?? null);
  if (before.tierId !== null && !old) return false;
  let capsOk: boolean;
  if (!old) {
    // No tier before: the merchant's own caps (if any) were hidden, so only the new tier's keys can be required.
    capsOk = afterCaps !== null && next.caps.every((c) => afterCaps.has(capKey(c)));
  } else {
    const oldMap = capMap(old.caps);
    const nextMap = capMap(next.caps);
    const keys = new Set([...nextMap.keys(), ...(beforeCaps?.keys() ?? []), ...(afterCaps?.keys() ?? [])]);
    capsOk = [...keys].every((k) => {
      const was = beforeCaps?.get(k);
      const now = afterCaps?.get(k);
      const tierWas = oldMap.get(k);
      const tierNext = nextMap.get(k);
      const forcedOwn = was !== undefined && (tierWas === undefined || !capEq(was, tierWas));
      if (forcedOwn) return now !== undefined && capEq(now, was);
      // Not visibly the merchant's own: it may still be an override that equals the old tier's value.
      const keepsOld = was === undefined ? now === undefined : now !== undefined && capEq(now, was);
      if (was === undefined) return tierNext ? now !== undefined && capEq(now, tierNext) : now === undefined;
      return keepsOld || (tierNext ? now !== undefined && capEq(now, tierNext) : now === undefined);
    });
  }
  const oldDerived = old ? (old.reserve ?? NO_RESERVE) : null;
  const noOverrideSeen = old ? reserveEq(before.reserve, oldDerived) : before.reserve === null;
  const reserveOk = reserveEq(after.reserve, before.reserve) || (noOverrideSeen && reserveEq(after.reserve, next.reserve ?? NO_RESERVE));
  return capsOk && reserveOk && rulesEq(merchantLayer(after), merchantLayer(before));
}

/** Did a tier this check depends on change after the page loaded it? Then a failed check cannot be called an incident: reload. */
export function relevantTiersChanged(
  handoff: Handoff,
  before: MerchantControlProfile,
  pageTiers: readonly TierView[],
  freshTiers: readonly TierView[],
): boolean {
  const ids = new Set(
    [before.tierId, handoff.change.kind === 'set_tier' ? handoff.change.tierId : null].filter((x): x is string => x !== null),
  );
  return [...ids].some((id) => {
    const a = pageTiers.find((t) => t.id === id);
    const b = freshTiers.find((t) => t.id === id);
    return stable(a ?? null) !== stable(b ?? null);
  });
}

// ── approvals: age and expiry in words ──────────────────────────────────────

export interface AgeView {
  readonly age: string;
  readonly expiry: { label: string; tone: 'live' | 'warn' | 'danger'; hint: string };
}

function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'under a minute';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
}

/** "3 h 5 min" since an ISO time, or null when the time cannot be read. */
export function waitedText(since: string, now: Date): string | null {
  const t = Date.parse(since);
  return Number.isFinite(t) ? span(now.getTime() - t) : null;
}

/**
 * How long a request has waited, and how much of its own validity window is left.
 * No SLA number has been agreed, so "soon" is relative to each request's own window: the last quarter of the
 * time between being asked and expiring. This is a display label; the service alone decides expiry.
 */
export function ageView(createdAt: string, expiresAt: string, now: Date): AgeView {
  const created = Date.parse(createdAt);
  const expires = Date.parse(expiresAt);
  const t = now.getTime();
  const age = `waiting ${span(t - created)}`;
  if (!Number.isFinite(created) || !Number.isFinite(expires)) {
    return {
      age: 'age unknown',
      expiry: { label: 'expiry unknown', tone: 'warn', hint: 'The request has no readable time, so it is not shown as safe.' },
    };
  }
  if (expires <= t)
    return {
      age,
      expiry: {
        label: 'expired',
        tone: 'danger',
        hint: 'This request ran out of time. It cannot be approved; the merchant has to ask again.',
      },
    };
  const left = expires - t;
  const window = Math.max(1, expires - created);
  return left * 4 <= window
    ? {
        age,
        expiry: { label: `expires in ${span(left)}`, tone: 'warn', hint: 'Less than a quarter of this request’s validity window is left.' },
      }
    : { age, expiry: { label: `expires in ${span(left)}`, tone: 'live', hint: 'Plenty of this request’s validity window is left.' } };
}
