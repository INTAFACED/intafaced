import type { AuditEntry, KillSwitchSnapshot } from '@/lib/control-plane-contract';
import { BLOCKERS } from './blockers';
import { blocked, refused, type Outcome } from './outcome';

/**
 * Pure rules for the Kill switch room: what the trade module's state is, what the edge will refuse before it
 * is asked (so the operator gets the real code instantly), and the two controls whose services do not exist
 * (venue halt-all, mass cancel). No network here; the route and the page call these.
 *
 * Codes mirror services/svc-edge (admin-api.ts, dual-control.ts, action-approval-consume.ts):
 *   missing_operator            confirming operator missing or the same as the signed-in operator
 *   action_approval.missing     approvalId or operationId missing ("a typed-in second name is not approval")
 *   edge.invalid_kill_switch    reason shorter than 12 or longer than 500 characters, or an unknown module
 */

/** The only module this room switches. Fixed: the desk never offers another module. */
export const TRADE_MODULE = 'trade' as const;
export const REASON_MIN = 12;
export const REASON_MAX = 500;
export const ID_MAX = 128;

export type TradeSwitchState =
  | {
      readonly stopped: false;
      readonly reason: null;
      readonly since: string | null;
      readonly by: string | null;
      readonly confirmedBy: string | null;
    }
  | {
      readonly stopped: true;
      readonly reason: string;
      readonly since: string | null;
      readonly by: string | null;
      readonly confirmedBy: string | null;
    };

/** Audit entries newest first (the edge already sends them that way; sorted here so the page never depends on it). */
export function auditNewestFirst(audit: readonly AuditEntry[]): AuditEntry[] {
  return [...audit].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Only the entries that belong to the trade module. */
export function tradeAudit(snapshot: KillSwitchSnapshot): AuditEntry[] {
  return auditNewestFirst(snapshot.audit.filter((e) => e.module === TRADE_MODULE));
}

/** Current state of the trade module, and when/by whom it last changed (the newest audit entry that changed it). */
export function tradeSwitchState(snapshot: KillSwitchSnapshot): TradeSwitchState {
  const stopped = snapshot.disabledModules.includes(TRADE_MODULE);
  const lastChange = tradeAudit(snapshot).find((e) => e.changed && e.next === stopped) ?? null;
  const common = { since: lastChange?.at ?? null, by: lastChange?.actor ?? null, confirmedBy: lastChange?.confirmOperatorId ?? null };
  if (!stopped) return { stopped: false, reason: null, ...common };
  return { stopped: true, reason: snapshot.reasons[TRADE_MODULE] ?? '', ...common };
}

export interface ToggleBody {
  readonly module: typeof TRADE_MODULE;
  readonly disabled: boolean;
  readonly reason: string;
  readonly confirmOperatorId: string;
  readonly approvalId: string;
  readonly operationId: string;
}

export type ToggleCheck =
  { readonly ok: true; readonly body: ToggleBody } | { readonly ok: false; readonly code: string; readonly message: string };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Check a disable/enable request the way the edge would, in the edge's own order: shape, reason, dual control, approval.
 * `signedInUserId` is the founder session; the confirming operator must be somebody else.
 */
export function checkToggle(input: Record<string, unknown>, signedInUserId: string): ToggleCheck {
  if (typeof input.disabled !== 'boolean')
    return {
      ok: false,
      code: 'edge.invalid_kill_switch',
      message: 'Say whether to stop (disabled: true) or resume (disabled: false) the trade module.',
    };
  const reason = text(input.reason);
  if (reason.length < REASON_MIN || reason.length > REASON_MAX)
    return {
      ok: false,
      code: 'edge.invalid_kill_switch',
      message: `The reason must be ${REASON_MIN} to ${REASON_MAX} characters; it is kept in the audit.`,
    };
  const confirmOperatorId = text(input.confirmOperatorId);
  if (confirmOperatorId === '')
    return {
      ok: false,
      code: 'missing_operator',
      message: 'confirming operator identity is required; the edge does not invent a second caller',
    };
  if (confirmOperatorId === signedInUserId.trim())
    return {
      ok: false,
      code: 'missing_operator',
      message: 'confirming operator must be a distinct identity; the edge does not invent a second caller',
    };
  const approvalId = text(input.approvalId);
  const operationId = text(input.operationId);
  if (approvalId === '' || operationId === '')
    return {
      ok: false,
      code: 'action_approval.missing',
      message: 'approvalId and operationId are required; a typed-in second name is not approval',
    };
  if (approvalId.length > ID_MAX || operationId.length > ID_MAX)
    return { ok: false, code: 'edge.invalid_kill_switch', message: `approvalId and operationId are at most ${ID_MAX} characters.` };
  return { ok: true, body: { module: TRADE_MODULE, disabled: input.disabled, reason, confirmOperatorId, approvalId, operationId } };
}

/** What the operator reads before confirming, in words (only what svc-edge's kill rule does). */
export function toggleConsequence(disabled: boolean): string {
  return disabled
    ? 'New orders on the trade module are refused by the edge with edge.module_killed (503) for every customer. Reads and order cancels still pass, so customers can see and cancel resting orders. This is not a venue halt: matching keeps running.'
    : 'The edge lets new orders through on the trade module again. Nothing is replayed; orders refused while it was stopped were never accepted.';
}

export const TRADE_ALWAYS_ALLOWED = [
  'Reads (GET), such as open orders and balances',
  'orders.cancel over tRPC, and DELETE /api/v1/orders and /api/v1/orders/:id (cancel)',
  'DELETE /api/v1/positions/:id (close one futures position)',
] as const;

// ── Venue halt-all / resume-all (matching): service missing ──────────────────

export interface VenueBody {
  readonly action: 'halt_all' | 'resume_all';
  readonly reason: string;
  readonly confirmOperatorId: string;
}

export function checkVenue(
  input: Record<string, unknown>,
  signedInUserId: string,
): { ok: true; body: VenueBody } | { ok: false; code: string; message: string } {
  if (input.action !== 'halt_all' && input.action !== 'resume_all')
    return { ok: false, code: 'trade_ops.bad_action', message: 'Choose halt all or resume all.' };
  const reason = text(input.reason);
  if (reason.length < REASON_MIN || reason.length > REASON_MAX)
    return { ok: false, code: 'trade_ops.bad_reason', message: `The reason must be ${REASON_MIN} to ${REASON_MAX} characters.` };
  const confirmOperatorId = text(input.confirmOperatorId);
  if (confirmOperatorId === '' || confirmOperatorId === signedInUserId.trim())
    return { ok: false, code: 'missing_operator', message: 'A distinct confirming operator is required.' };
  return { ok: true, body: { action: input.action, reason, confirmOperatorId } };
}

export function venueOutcome(input: Record<string, unknown>, signedInUserId: string): Outcome<never> {
  const c = checkVenue(input, signedInUserId);
  return c.ok ? blocked(BLOCKERS.matching_not_routed) : refused(c.code, c.message, 400);
}

// ── Mass cancel: service missing ─────────────────────────────────────────────

export interface MassCancelBody {
  readonly scope: 'market' | 'account';
  readonly target: string;
  readonly reason: string;
  readonly confirmOperatorId: string;
}

const SYMBOL = /^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkMassCancel(
  input: Record<string, unknown>,
  signedInUserId: string,
): { ok: true; body: MassCancelBody } | { ok: false; code: string; message: string } {
  const scope = input.scope;
  if (scope !== 'market' && scope !== 'account')
    return { ok: false, code: 'trade_ops.bad_scope', message: 'Choose a market or an account.' };
  const target = text(input.target);
  if (scope === 'market' && !SYMBOL.test(target))
    return { ok: false, code: 'trade_ops.bad_target', message: 'A market symbol looks like BTC/USDT.' };
  if (scope === 'account' && !UUID.test(target))
    return { ok: false, code: 'trade_ops.bad_target', message: 'An account is identified by its user id (a UUID).' };
  const reason = text(input.reason);
  if (reason.length < REASON_MIN || reason.length > REASON_MAX)
    return { ok: false, code: 'trade_ops.bad_reason', message: `The reason must be ${REASON_MIN} to ${REASON_MAX} characters.` };
  const confirmOperatorId = text(input.confirmOperatorId);
  if (confirmOperatorId === '' || confirmOperatorId === signedInUserId.trim())
    return { ok: false, code: 'missing_operator', message: 'A distinct confirming operator is required.' };
  return { ok: true, body: { scope, target, reason, confirmOperatorId } };
}

export function massCancelOutcome(input: Record<string, unknown>, signedInUserId: string): Outcome<never> {
  const c = checkMassCancel(input, signedInUserId);
  return c.ok ? blocked(BLOCKERS.mass_cancel_operator_missing) : refused(c.code, c.message, 400);
}

/** What the customer-side tool does today, so the operator knows the gap. */
export const MASS_CANCEL_TODAY =
  'Today a signed-in customer can cancel all of their own open orders (DELETE /api/v1/orders, optionally by symbol). There is no operator version by market or by account.';

// ── What each switch does not do (TRD-0193) ──────────────────────────────────

export interface SwitchExplainer {
  readonly name: string;
  readonly stops: string;
  readonly doesNotStop: string;
}

export const SWITCH_EXPLAINERS: readonly SwitchExplainer[] = [
  {
    name: 'Kill switch (this room)',
    stops: 'New order placement on the whole trade module, for everyone, at the edge.',
    doesNotStop: 'Cancels and reads. Matching keeps running. It does not touch identity, the ledger or any single account.',
  },
  {
    name: 'Trading restriction (one account)',
    stops: 'New trading by one account, applied per account in Freezes & approvals.',
    doesNotStop: 'Any other account. It does not switch off the trade module and is not a kill switch.',
  },
  {
    name: 'Identity freeze (one account)',
    stops: 'Whatever svc-identity blocks for one account when it freezes it.',
    doesNotStop: 'The trade module for everyone else. It is decided in identity, not in this room, and is not a kill switch.',
  },
  {
    name: 'Ledger posting freeze',
    stops: 'All value movement platform-wide (admin:treasury, svc-ledger).',
    doesNotStop: 'The trade module switch. It needs its own authority (admin:treasury) and is not in this room.',
  },
];
