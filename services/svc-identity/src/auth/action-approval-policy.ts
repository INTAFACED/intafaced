/**
 * Owner approval policy rows per governed action type (OPS-change-control-01 CR-1).
 *
 * The source is one owner setting, `IDENTITY_ACTION_APPROVAL_POLICIES`, a JSON object keyed by governed action type:
 *
 *   {"ops.ledger.reverse": {"requiredApprovals": "2", "approverAudience": "founder", "applier": "svc-ops", "maxAgeSeconds": "3600"}}
 *
 * Counts and seconds are whole numbers, as a JSON integer or a string of digits. Each row is read on its own: a row
 * that is missing, blank, zero, fractional, has an unknown key, names an unknown audience, or sits in a value that is
 * not JSON at all, is unset for its type only and refuses `action_approval.policy_unset`. Nothing here supplies a
 * default. A key that is not a governed type is ignored: an ungoverned type keeps the fixed rule.
 */
import { createHash } from 'node:crypto';
import {
  POLICY_GOVERNED_ACTION_TYPES,
  approvalPolicyAudienceSchema,
  governedActionTypeOf,
  type ActionApprovalPolicy,
  type ActionApprovalPolicyEntry,
  type PolicyGovernedActionType,
} from '@intafaced/contracts';

/** Upper bounds are shape guards, not owner values: no request lives a year, no rule needs more than 32 people. */
const MAX_REQUIRED_APPROVALS = 32;
const MAX_AGE_SECONDS = 31_536_000;
const ROW_KEYS = ['requiredApprovals', 'approverAudience', 'applier', 'maxAgeSeconds'] as const;

export type PolicyLookup = { readonly state: 'set'; readonly policy: ActionApprovalPolicy } | { readonly state: 'unset' };

/** Called on every propose, approve and consume, so a request is always judged against the row as it stands now. */
export type ApprovalPolicySource = (actionType: PolicyGovernedActionType) => PolicyLookup;

const UNSET: PolicyLookup = { state: 'unset' };

function wholeNumber(value: unknown, max: number): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n <= max ? n : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The version a request is bound to: a hash of the type and the row's values, in a fixed key order. */
export function policyVersionOf(actionType: PolicyGovernedActionType, row: Omit<ActionApprovalPolicy, 'version'>): string {
  const canonical = JSON.stringify([actionType, row.requiredApprovals, row.approverAudience, row.applier, row.maxAgeSeconds]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function readRow(actionType: PolicyGovernedActionType, raw: unknown): PolicyLookup {
  if (!isRecord(raw)) return UNSET;
  if (Object.keys(raw).some((k) => !(ROW_KEYS as readonly string[]).includes(k))) return UNSET;
  const requiredApprovals = wholeNumber(raw.requiredApprovals, MAX_REQUIRED_APPROVALS);
  const maxAgeSeconds = wholeNumber(raw.maxAgeSeconds, MAX_AGE_SECONDS);
  const audience = approvalPolicyAudienceSchema.safeParse(typeof raw.approverAudience === 'string' ? raw.approverAudience.trim() : null);
  const applier = typeof raw.applier === 'string' ? raw.applier.trim() : '';
  if (requiredApprovals === null || maxAgeSeconds === null || !audience.success) return UNSET;
  if (!/^svc-[a-z0-9-]{1,60}$/.test(applier)) return UNSET;
  // The founders are a fixed pair and the requester is one of them, so a founder row can never gather more than one
  // other approver: a larger count could never be met, and is read as no row rather than a request that only expires.
  if (audience.data === 'founder' && requiredApprovals > 1) return UNSET;
  const values = { requiredApprovals, approverAudience: audience.data, applier, maxAgeSeconds };
  return { state: 'set', policy: { ...values, version: policyVersionOf(actionType, values) } };
}

/** Read the whole setting into one lookup per governed type. Pure; the caller decides how often it is read. */
export function readApprovalPolicies(raw: string | undefined): Record<PolicyGovernedActionType, PolicyLookup> {
  const out = Object.fromEntries(POLICY_GOVERNED_ACTION_TYPES.map((t) => [t, UNSET])) as Record<PolicyGovernedActionType, PolicyLookup>;
  if (raw === undefined || raw.trim() === '') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isRecord(parsed)) return out;
  const seen = new Map<PolicyGovernedActionType, number>();
  for (const key of Object.keys(parsed)) {
    const type = governedActionTypeOf(key);
    if (type) seen.set(type, (seen.get(type) ?? 0) + 1);
  }
  for (const key of Object.keys(parsed)) {
    const type = governedActionTypeOf(key);
    // Two spellings of one type are ambiguous: neither is read.
    if (!type || seen.get(type) !== 1) continue;
    out[type] = readRow(type, parsed[key]);
  }
  return out;
}

/** A source over a raw setting. Production passes the env value; it is read again only when the value changes. */
export function approvalPolicySource(readRaw: () => string | undefined): ApprovalPolicySource {
  let last: { raw: string | undefined; read: Record<PolicyGovernedActionType, PolicyLookup> } | null = null;
  return (actionType) => {
    const raw = readRaw();
    if (last === null || last.raw !== raw) last = { raw, read: readApprovalPolicies(raw) };
    return last.read[actionType];
  };
}

/** Every governed type with its row or `unset`, for the founder and operator read. */
export function approvalPolicyEntries(source: ApprovalPolicySource | undefined): ActionApprovalPolicyEntry[] {
  return POLICY_GOVERNED_ACTION_TYPES.map((actionType) => {
    let found: PolicyLookup = UNSET;
    try {
      found = source ? source(actionType) : UNSET;
    } catch {
      found = UNSET;
    }
    return found.state === 'set'
      ? { state: 'set' as const, actionType, policy: found.policy }
      : { state: 'unset' as const, actionType, code: 'action_approval.policy_unset' as const };
  });
}
