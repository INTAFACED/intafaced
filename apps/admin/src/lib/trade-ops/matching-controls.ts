import { createHash } from 'node:crypto';

/**
 * The nine matching controls svc-edge routes to operators (`/admin/trade-ops/matching/...`, EDGEOPSBE #4948). Each needs an
 * APPROVED two-person approval filed against svc-matching with the exact action type and target below; svc-edge reads it
 * (never consumes it) and svc-matching consumes it. Pure data and rules: no network, no env.
 */

export type MatchingActionName =
  'halt' | 'resume' | 'reduce_only' | 'reduce_only_off' | 'post_only' | 'post_only_off' | 'delist' | 'halt_all' | 'resume_all';

export interface MatchingActionSpec {
  readonly name: MatchingActionName;
  readonly label: string;
  /** The approval's action type, as svc-matching checks it. */
  readonly actionType: string;
  /** True for the seven per-market controls; false for venue-wide halt-all and resume-all. */
  readonly perMarket: boolean;
  /** Path under /admin/trade-ops/matching on svc-edge. */
  readonly edgeSuffix: string;
  readonly targetPrefix: string;
}

const spec = (
  name: MatchingActionName,
  label: string,
  actionType: string,
  perMarket: boolean,
  edgeSuffix: string,
  targetPrefix: string,
): MatchingActionSpec => ({ name, label, actionType, perMarket, edgeSuffix, targetPrefix });

export const MATCHING_ACTIONS: readonly MatchingActionSpec[] = [
  spec('halt', 'Halt', 'matching.halt', true, 'halt', 'halt'),
  spec('resume', 'Resume', 'matching.resume', true, 'resume', 'resume'),
  spec('reduce_only', 'Reduce-only on', 'matching.reduce_only', true, 'reduce-only', 'reduce_only'),
  spec('reduce_only_off', 'Reduce-only off', 'matching.reduce_only_resume', true, 'reduce-only/off', 'reduce_only_resume'),
  spec('post_only', 'Post-only on', 'matching.post_only', true, 'post-only', 'post_only'),
  spec('post_only_off', 'Post-only off', 'matching.post_only_resume', true, 'post-only/off', 'post_only_resume'),
  spec('delist', 'Delist', 'matching.delist', true, 'delist', 'delist'),
  spec('halt_all', 'Halt all markets', 'matching.halt_all', false, 'halt-all', 'halt_all'),
  spec('resume_all', 'Resume all markets', 'matching.resume_all', false, 'resume-all', 'resume_all'),
];

export const matchingActionSpec = (name: unknown): MatchingActionSpec | null => MATCHING_ACTIONS.find((a) => a.name === name) ?? null;

export const MATCHING_TARGET_SERVICE = 'svc-matching';
/** svc-matching consumes with expectedVersion '1'; the proposal must carry the same. */
export const MATCHING_EXPECTED_VERSION = '1';
export const MATCHING_POLICY_VERSION = 'matching-control-v1';

export const matchingTargetId = (a: MatchingActionSpec, marketId: string | null): string =>
  a.perMarket ? `${a.targetPrefix}:${marketId ?? ''}` : a.targetPrefix;

/** The hash svc-matching recomputes at consume time (`matchingActionPayloadHash`): sha256 of { actionType, ...fields }. */
export function matchingPayloadHash(a: MatchingActionSpec, marketId: string | null): string {
  const payload = JSON.stringify(a.perMarket ? { actionType: a.actionType, marketId } : { actionType: a.actionType });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function matchingEdgePath(a: MatchingActionSpec, marketId: string | null): string {
  return a.perMarket
    ? `/admin/trade-ops/matching/markets/${encodeURIComponent(marketId ?? '')}/${a.edgeSuffix}`
    : `/admin/trade-ops/matching/${a.edgeSuffix}`;
}

/** Same approval and target always give the same client request id, so a replay returns the first result. */
export const matchingIdempotencyKey = (a: MatchingActionSpec, marketId: string | null, approvalId: string): string =>
  `desk-${a.name}-${marketId ?? 'venue'}-${approvalId}`.slice(0, 200);

export type MatchingStep = 'propose' | 'status' | 'run';

export type MatchingCheck =
  | {
      readonly ok: true;
      readonly step: MatchingStep;
      readonly action: MatchingActionSpec;
      readonly marketId: string | null;
      readonly approvalId: string | null;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

const bad = (code: string, message: string): MatchingCheck => ({ ok: false, code, message });
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * What must be true before anything leaves the console. There is no typed second operator: the approval carries both people.
 * `delist` also needs the symbol typed back exactly. `status` and `run` need the approval id; `propose` does not.
 */
export function checkMatchingRequest(body: Record<string, unknown>): MatchingCheck {
  const action = matchingActionSpec(body.action);
  if (!action) return bad('trade_ops.bad_action', 'Unknown matching control.');
  const step = body.step;
  if (step !== 'propose' && step !== 'status' && step !== 'run') return bad('trade_ops.bad_step', 'Choose propose, status or run.');
  const marketId = text(body.marketId);
  if (action.perMarket && marketId === '') return bad('trade_ops.market_required', 'A market id is required.');
  if (!action.perMarket && marketId !== '')
    return bad('trade_ops.market_not_allowed', 'This control covers the whole venue, not one market.');
  if (action.name === 'delist' && step !== 'status') {
    const symbol = text(body.symbol);
    if (symbol === '' || text(body.typedSymbol) !== symbol)
      return bad('trade_ops.symbol_mismatch', `Delist cannot be undone: type the symbol ${symbol || 'of the market'} exactly to confirm.`);
  }
  const approvalId = text(body.approvalId);
  if (step !== 'propose') {
    if (approvalId === '') return bad('trade_ops.approval_required', 'Enter the approval id.');
    if (!APPROVAL_ID.test(approvalId)) return bad('trade_ops.approval_invalid', 'The approval id is not a valid id.');
  }
  return { ok: true, step, action, marketId: action.perMarket ? marketId : null, approvalId: approvalId || null };
}
