/**
 * The maker incentive programme's terms and members and the launch-liquidity plan per market, as values
 * (J-cex-spot-20 #8; RC-cex-spot-06, RC-cex-spot-09). Pure: no imports, no I/O.
 *
 * This file exists twice, byte for byte: `services/svc-trade/src/admin/maker-programme-model.ts` (the rule, applied
 * when svc-trade writes a version) and `apps/admin/src/lib/trade-ops/maker-programme-model.ts` (the console refuses a
 * blank by name before anything is filed, and binds the approval to the same body). The console's test reads both and
 * fails when they differ.
 *
 * Every value travels as a string as the operator typed it; null or blank is "not set" and refuses by name. Nothing is
 * filled in. Decimals stay strings; no value here is money held or moved.
 */

export const MAKER_PROGRAMME_TERM_UNSET = 'trade.maker_programme_term_unset';
export const MAKER_PROGRAMME_TERM_INVALID = 'trade.maker_programme_term_invalid';
export const MAKER_PROGRAMME_MEMBER_UNSET = 'trade.maker_programme_member_unset';
export const MAKER_PROGRAMME_MEMBER_INVALID = 'trade.maker_programme_member_invalid';
export const MAKER_PROGRAMME_TIER_UNKNOWN = 'trade.maker_programme_tier_unknown';
export const LAUNCH_PLAN_UNSET = 'trade.launch_plan_unset';
export const LAUNCH_PLAN_INVALID = 'trade.launch_plan_invalid';
export const LAUNCH_PLAN_MAKER_UNKNOWN = 'trade.launch_plan_maker_unknown';

export const MAKER_TERMS_ACTION_TYPE = 'trade.maker_programme_terms';
export const MAKER_MEMBER_ACTION_TYPE = 'trade.maker_programme_member';
export const LAUNCH_PLAN_ACTION_TYPE = 'trade.launch_liquidity_plan';
/** The approval target of a terms version: there is one programme. */
export const MAKER_TERMS_TARGET = 'maker-programme';

export type Typed = string | null;

export interface TierInput {
  readonly name: Typed;
  /** 30-day maker volume a member needs for this tier (quote units). */
  readonly minMakerVolume30d: Typed;
  /** Share of the period quoting within the obligations, in percent. */
  readonly minUptimePct: Typed;
  /** Widest spread at the minimum depth for this tier, in bps. */
  readonly maxSpreadAtDepthBps: Typed;
  readonly rebateBps: Typed;
}

export interface TermsInput {
  readonly tiers: readonly TierInput[];
  readonly maxSpreadBps: Typed;
  readonly minDepth: Typed;
  readonly minUptimePct: Typed;
  readonly cancelToFillCeiling: Typed;
  readonly clawbackWindowDays: Typed;
  readonly equalAccessCriteria: Typed;
}

export type MemberStatus = 'active' | 'suspended' | 'exited';

export interface MemberInput {
  readonly accountId: Typed;
  readonly tier: Typed;
  readonly status: MemberStatus | null;
  readonly conflictDeclaration: Typed;
}

export interface PlanMakerInput {
  readonly accountId: Typed;
  readonly capital: Typed;
  readonly asset: Typed;
}

export interface PlanInput {
  readonly makers: readonly PlanMakerInput[];
  readonly maxSpreadBps: Typed;
  readonly minDepth: Typed;
  readonly depthBandBps: Typed;
  readonly minUptimePct: Typed;
  readonly inventoryMin: Typed;
  readonly inventoryMax: Typed;
  readonly exitReviewDate: Typed;
  readonly exitUptimeBelowPct: Typed;
  readonly exitSpreadAboveBps: Typed;
}

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };

const blank = (v: Typed | undefined): boolean => v == null || v.trim() === '';
const t = (v: Typed): string => (v ?? '').trim();

const BPS = /^[1-9]\d{0,4}$/;
const REBATE_BPS = /^(?:0|[1-9]\d{0,3})$/;
const DAYS = /^[1-9]\d{0,3}$/;
const DECIMAL = /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/;
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/;
const PCT = /^(?:100(?:\.0{1,4})?|[1-9]?\d(?:\.\d{1,4})?)$/;
const ASSET = /^[A-Z0-9]{2,12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const zero = (v: string): boolean => /^-?0(?:\.0+)?$/.test(v);

const positiveDecimal = (v: string) => DECIMAL.test(v) && !zero(v);
const pct = (v: string) => PCT.test(v) && !zero(v);
const realDate = (v: string): boolean => {
  const m = DATE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};
/** The programme's terms as svc-trade stores and binds them, or the refusal naming the first blank or bad term. */
export function checkTerms(input: TermsInput): Checked<TermsInput> {
  const unset = (name: string): Checked<TermsInput> => ({
    ok: false,
    code: MAKER_PROGRAMME_TERM_UNSET,
    message: `${name} is not set; the programme has no terms until every term is set`,
  });
  const bad = (message: string): Checked<TermsInput> => ({ ok: false, code: MAKER_PROGRAMME_TERM_INVALID, message });
  if (input.tiers.length === 0) return unset('tiers');
  for (const [i, tier] of input.tiers.entries()) {
    const n = `tier ${i + 1}`;
    if (blank(tier.name)) return unset(`${n} name`);
    if (blank(tier.minMakerVolume30d)) return unset(`${n} 30-day maker volume`);
    if (blank(tier.minUptimePct)) return unset(`${n} uptime share`);
    if (blank(tier.maxSpreadAtDepthBps)) return unset(`${n} spread at depth`);
    if (blank(tier.rebateBps)) return unset(`${n} rebate`);
  }
  if (blank(input.maxSpreadBps)) return unset('max spread');
  if (blank(input.minDepth)) return unset('min depth');
  if (blank(input.minUptimePct)) return unset('min uptime');
  if (blank(input.cancelToFillCeiling)) return unset('cancel-to-fill ceiling');
  if (blank(input.clawbackWindowDays)) return unset('clawback window');
  if (blank(input.equalAccessCriteria)) return unset('equal-access criteria');
  const tiers = input.tiers.map((x) => ({
    name: t(x.name),
    minMakerVolume30d: t(x.minMakerVolume30d),
    minUptimePct: t(x.minUptimePct),
    maxSpreadAtDepthBps: t(x.maxSpreadAtDepthBps),
    rebateBps: t(x.rebateBps),
  }));
  if (tiers.length > 10) return bad('the programme has at most 10 tiers');
  if (new Set(tiers.map((x) => x.name.toLowerCase())).size !== tiers.length) return bad('each tier has its own name');
  for (const [i, x] of tiers.entries()) {
    const n = `tier ${i + 1}`;
    if (x.name.length > 40) return bad(`${n} name is at most 40 characters`);
    if (!DECIMAL.test(x.minMakerVolume30d)) return bad(`${n} 30-day maker volume is a decimal of 0 or more`);
    if (!pct(x.minUptimePct)) return bad(`${n} uptime share is a percent above 0, at most 100`);
    if (!BPS.test(x.maxSpreadAtDepthBps)) return bad(`${n} spread at depth is a whole number of bps above 0`);
    if (!REBATE_BPS.test(x.rebateBps)) return bad(`${n} rebate is a whole number of bps from 0 to 9999`);
  }
  const value: TermsInput = {
    tiers,
    maxSpreadBps: t(input.maxSpreadBps),
    minDepth: t(input.minDepth),
    minUptimePct: t(input.minUptimePct),
    cancelToFillCeiling: t(input.cancelToFillCeiling),
    clawbackWindowDays: t(input.clawbackWindowDays),
    equalAccessCriteria: t(input.equalAccessCriteria),
  };
  if (!BPS.test(value.maxSpreadBps!)) return bad('max spread is a whole number of bps above 0');
  if (!positiveDecimal(value.minDepth!)) return bad('min depth is a decimal above 0');
  if (!pct(value.minUptimePct!)) return bad('min uptime is a percent above 0, at most 100');
  if (!positiveDecimal(value.cancelToFillCeiling!)) return bad('cancel-to-fill ceiling is a decimal above 0');
  if (!DAYS.test(value.clawbackWindowDays!)) return bad('clawback window is a whole number of days above 0');
  if (value.equalAccessCriteria!.length > 2000) return bad('equal-access criteria is at most 2000 characters');
  return { ok: true, value };
}

/** A member's admission as svc-trade binds it, or the refusal naming its first blank. Tiers are checked by the writer. */
export function checkMember(input: MemberInput): Checked<MemberInput> {
  const unset = (name: string): Checked<MemberInput> => ({ ok: false, code: MAKER_PROGRAMME_MEMBER_UNSET, message: `${name} is not set` });
  const bad = (message: string): Checked<MemberInput> => ({ ok: false, code: MAKER_PROGRAMME_MEMBER_INVALID, message });
  if (blank(input.accountId)) return unset('account');
  if (blank(input.tier)) return unset('tier');
  if (input.status == null) return unset('status');
  if (blank(input.conflictDeclaration)) return unset('conflict declaration');
  const value: MemberInput = {
    accountId: t(input.accountId).toLowerCase(),
    tier: t(input.tier),
    status: input.status,
    conflictDeclaration: t(input.conflictDeclaration),
  };
  if (!UUID.test(value.accountId!)) return bad('account is an account id');
  if (!['active', 'suspended', 'exited'].includes(value.status!)) return bad('status is active, suspended or exited');
  if (value.conflictDeclaration!.length > 2000) return bad('conflict declaration is at most 2000 characters');
  return { ok: true, value };
}

/**
 * A launch-liquidity plan as svc-trade binds it, or the refusal naming its first blank. Makers, and the inventory band's
 * order (low at most high, compared exactly with the ledger's own decimal parser), are checked by svc-trade's writer.
 */
export function checkPlan(input: PlanInput): Checked<PlanInput> {
  const unset = (name: string): Checked<PlanInput> => ({
    ok: false,
    code: LAUNCH_PLAN_UNSET,
    message: `${name} is not set; the plan is not complete until it is`,
  });
  const bad = (message: string): Checked<PlanInput> => ({ ok: false, code: LAUNCH_PLAN_INVALID, message });
  if (input.makers.length === 0) return unset('makers');
  for (const [i, m] of input.makers.entries()) {
    const n = `maker ${i + 1}`;
    if (blank(m.accountId)) return unset(`${n} account`);
    if (blank(m.capital)) return unset(`${n} capital`);
    if (blank(m.asset)) return unset(`${n} capital asset`);
  }
  if (blank(input.maxSpreadBps)) return unset('max spread');
  if (blank(input.minDepth)) return unset('min depth');
  if (blank(input.depthBandBps)) return unset('depth band');
  if (blank(input.minUptimePct)) return unset('min uptime');
  if (blank(input.inventoryMin)) return unset('inventory band low');
  if (blank(input.inventoryMax)) return unset('inventory band high');
  if (blank(input.exitReviewDate)) return unset('exit criteria: review date');
  if (blank(input.exitUptimeBelowPct)) return unset('exit criteria: uptime threshold');
  if (blank(input.exitSpreadAboveBps)) return unset('exit criteria: spread threshold');
  const makers = input.makers.map((m) => ({
    accountId: t(m.accountId).toLowerCase(),
    capital: t(m.capital),
    asset: t(m.asset).toUpperCase(),
  }));
  if (makers.length > 20) return bad('a plan names at most 20 makers');
  if (new Set(makers.map((m) => m.accountId)).size !== makers.length) return bad('each maker is named once');
  for (const [i, m] of makers.entries()) {
    const n = `maker ${i + 1}`;
    if (!UUID.test(m.accountId)) return bad(`${n} account is an account id`);
    if (!positiveDecimal(m.capital)) return bad(`${n} capital is a decimal above 0`);
    if (!ASSET.test(m.asset)) return bad(`${n} capital asset is an asset code`);
  }
  const value: PlanInput = {
    makers,
    maxSpreadBps: t(input.maxSpreadBps),
    minDepth: t(input.minDepth),
    depthBandBps: t(input.depthBandBps),
    minUptimePct: t(input.minUptimePct),
    inventoryMin: t(input.inventoryMin),
    inventoryMax: t(input.inventoryMax),
    exitReviewDate: t(input.exitReviewDate),
    exitUptimeBelowPct: t(input.exitUptimeBelowPct),
    exitSpreadAboveBps: t(input.exitSpreadAboveBps),
  };
  if (!BPS.test(value.maxSpreadBps!)) return bad('max spread is a whole number of bps above 0');
  if (!positiveDecimal(value.minDepth!)) return bad('min depth is a decimal above 0');
  if (!BPS.test(value.depthBandBps!)) return bad('depth band is a whole number of bps above 0');
  if (!pct(value.minUptimePct!)) return bad('min uptime is a percent above 0, at most 100');
  if (!SIGNED_DECIMAL.test(value.inventoryMin!)) return bad('inventory band low is a decimal');
  if (!SIGNED_DECIMAL.test(value.inventoryMax!)) return bad('inventory band high is a decimal');
  if (!realDate(value.exitReviewDate!)) return bad('exit criteria: review date is a date, YYYY-MM-DD');
  if (!pct(value.exitUptimeBelowPct!)) return bad('exit criteria: uptime threshold is a percent above 0, at most 100');
  if (!BPS.test(value.exitSpreadAboveBps!)) return bad('exit criteria: spread threshold is a whole number of bps above 0');
  return { ok: true, value };
}

/** The approval bodies. Both sides hash exactly these with their canonical JSON (sorted keys). */
export function termsApprovalBody(expectedVersion: string, terms: TermsInput) {
  return { actionType: MAKER_TERMS_ACTION_TYPE, target: MAKER_TERMS_TARGET, expectedVersion, terms };
}

export function memberApprovalBody(expectedVersion: string, member: MemberInput) {
  return { actionType: MAKER_MEMBER_ACTION_TYPE, accountId: member.accountId, expectedVersion, member };
}

export function planApprovalBody(market: string, expectedVersion: string, plan: PlanInput) {
  return { actionType: LAUNCH_PLAN_ACTION_TYPE, market, expectedVersion, plan };
}
