import { createHash } from 'node:crypto';
import { canonicalJson } from './fees-hash';
import {
  memberApprovalBody,
  planApprovalBody,
  termsApprovalBody,
  type MemberInput,
  type MemberStatus,
  type PlanInput,
  type TermsInput,
} from './maker-programme-model';

/**
 * The maker programme and launch-liquidity rooms' reads and approval hashes (J-cex-spot-20 #8). The values and the
 * approval bodies come from `maker-programme-model.ts`, the same file svc-trade applies; the hash is sha256 of the same
 * canonical JSON svc-trade's `payloadHash` computes, pinned byte for byte in both packages' tests.
 */

export const MAKER_PROGRAMME_TARGET_SERVICE = 'svc-trade';
export const MAKER_TERMS_POLICY_VERSION = 'trade-maker-programme-terms-v1';
export const MAKER_MEMBER_POLICY_VERSION = 'trade-maker-programme-member-v1';
export const LAUNCH_PLAN_POLICY_VERSION = 'trade-launch-liquidity-plan-v1';

const sha = (v: unknown) => `sha256:${createHash('sha256').update(canonicalJson(v)).digest('hex')}`;
export const termsPayloadHash = (expectedVersion: string, terms: TermsInput) => sha(termsApprovalBody(expectedVersion, terms));
export const memberPayloadHash = (expectedVersion: string, member: MemberInput) => sha(memberApprovalBody(expectedVersion, member));
export const planPayloadHash = (market: string, expectedVersion: string, plan: PlanInput) =>
  sha(planApprovalBody(market, expectedVersion, plan));

export interface VersionStamp {
  readonly version: string;
  readonly operatorId: string;
  readonly approverId: string;
  readonly approvalId: string;
  readonly writtenAt: string;
}
export type TermsRow = TermsInput & VersionStamp;
export type MemberRow = MemberInput & VersionStamp & { readonly termsVersion: string };
export type PlanState = 'draft' | 'approved' | 'active' | 'exited';
export type PlanRow = PlanInput & VersionStamp & { readonly market: string; readonly symbol: string; readonly state: PlanState };
export interface MarketPlan {
  readonly market: string;
  readonly symbol: string;
  readonly status: string;
  readonly plan: PlanRow | null;
}
export interface ClawbackRow {
  readonly id: string;
  readonly period: string;
  readonly accountId: string;
  readonly market: string | null;
  readonly amount: string;
  readonly asset: string;
  readonly state: 'pending' | 'posted';
  readonly findingRef: string;
  readonly createdAt: string;
}

type R = Record<string, unknown>;
const obj = (v: unknown): R | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as R) : null);
const str = (v: unknown): v is string => typeof v === 'string';
const strs = (r: R, keys: readonly string[]) => keys.every((k) => str(r[k]));
const STAMP = ['version', 'operatorId', 'approverId', 'approvalId', 'writtenAt'] as const;
const TIER = ['name', 'minMakerVolume30d', 'minUptimePct', 'maxSpreadAtDepthBps', 'rebateBps'] as const;
const TERMS = ['maxSpreadBps', 'minDepth', 'minUptimePct', 'cancelToFillCeiling', 'clawbackWindowDays', 'equalAccessCriteria'] as const;
const PLAN = [
  'maxSpreadBps',
  'minDepth',
  'depthBandBps',
  'minUptimePct',
  'inventoryMin',
  'inventoryMax',
  'exitReviewDate',
  'exitUptimeBelowPct',
  'exitSpreadAboveBps',
] as const;
const STATUSES: readonly MemberStatus[] = ['active', 'suspended', 'exited'];
const PLAN_STATES: readonly PlanState[] = ['draft', 'approved', 'active', 'exited'];

export function parseTermsRow(v: unknown): TermsRow | null {
  const r = obj(v);
  if (!r || !strs(r, STAMP) || !strs(r, TERMS) || !Array.isArray(r.tiers)) return null;
  if (!r.tiers.every((t) => obj(t) !== null && strs(obj(t)!, TIER))) return null;
  return r as unknown as TermsRow;
}

/** `{ terms: TermsRow | null }`; null terms means none written. */
export function parseTerms(v: unknown): { terms: TermsRow | null } | null {
  const r = obj(v);
  if (!r || !('terms' in r)) return null;
  if (r.terms === null) return { terms: null };
  const terms = parseTermsRow(r.terms);
  return terms ? { terms } : null;
}

export function parseMemberRow(v: unknown): MemberRow | null {
  const r = obj(v);
  if (!r || !strs(r, STAMP) || !strs(r, ['accountId', 'tier', 'conflictDeclaration', 'termsVersion'])) return null;
  return STATUSES.includes(r.status as MemberStatus) ? (r as unknown as MemberRow) : null;
}

export function parseMembers(v: unknown): readonly MemberRow[] | null {
  const list = obj(v)?.members;
  if (!Array.isArray(list)) return null;
  const rows = list.map(parseMemberRow);
  return rows.every((x): x is MemberRow => x !== null) ? rows : null;
}

export function parseClawbacks(v: unknown): readonly ClawbackRow[] | null {
  const list = obj(v)?.clawbacks;
  if (!Array.isArray(list)) return null;
  const ok = list.every((x) => {
    const r = obj(x);
    return (
      r !== null &&
      strs(r, ['id', 'period', 'accountId', 'amount', 'asset', 'findingRef', 'createdAt']) &&
      (r.market === null || str(r.market)) &&
      (r.state === 'pending' || r.state === 'posted')
    );
  });
  return ok ? (list as ClawbackRow[]) : null;
}

export function parsePlanRow(v: unknown): PlanRow | null {
  const r = obj(v);
  if (!r || !strs(r, STAMP) || !strs(r, PLAN) || !strs(r, ['market', 'symbol']) || !Array.isArray(r.makers)) return null;
  if (!PLAN_STATES.includes(r.state as PlanState)) return null;
  if (!r.makers.every((m) => obj(m) !== null && strs(obj(m)!, ['accountId', 'capital', 'asset']))) return null;
  return r as unknown as PlanRow;
}

export function parseMarketPlans(v: unknown): readonly MarketPlan[] | null {
  const list = obj(v)?.markets;
  if (!Array.isArray(list)) return null;
  const rows = list.map((x): MarketPlan | null => {
    const r = obj(x);
    if (!r || !strs(r, ['market', 'symbol', 'status'])) return null;
    if (r.plan === null) return { market: r.market as string, symbol: r.symbol as string, status: r.status as string, plan: null };
    const plan = parsePlanRow(r.plan);
    return plan ? { market: r.market as string, symbol: r.symbol as string, status: r.status as string, plan } : null;
  });
  return rows.every((x): x is MarketPlan => x !== null) ? rows : null;
}
