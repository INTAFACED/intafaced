import type { AuditEntry, ControlPlaneState, KillSwitchSnapshot } from '@/lib/control-plane-contract';
import { BLOCKERS } from './blockers';
import { blocked, ok, refused, unknown, type Outcome } from './outcome';

/**
 * Pure rules for the Kill switch room: what the trade module's state is, and the control whose service does
 * not exist (mass cancel). Venue halt-all and resume-all live in matching-controls.ts. No network here; the route and the page call these. Stopping and
 * resuming the trade module is NOT here: it runs through the console's two-founder flow (`/api/kill-switch`,
 * `ModuleKillDesk`), the only path the edge's operator door accepts.
 */

/** The only module this room switches. Fixed: the desk never offers another module. */
export const TRADE_MODULE = 'trade' as const;
export const REASON_MIN = 12;
export const REASON_MAX = 500;

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

/**
 * The console's read of the edge's module state, as a desk outcome. Only a decoded snapshot is `ok`. The operator door
 * refusing us (401/403) or the console not being configured is `refused` with the edge's own code; anything that did not
 * finish (unreachable, 5xx, a body that is not a snapshot, still loading) is `unknown`. Never "Open" without a snapshot.
 */
export function killStateOutcome(state: ControlPlaneState, asOf: string = new Date().toISOString()): Outcome<KillSwitchSnapshot> {
  const detail = state.detail ?? 'The kill switch state was not read.';
  switch (state.status) {
    case 'reachable':
      return ok(state.snapshot, asOf);
    case 'unconfigured':
      return refused(state.code ?? 'admin.kill_unconfigured', detail, state.httpStatus ?? 503, null, asOf);
    case 'refused':
      return refused(state.code ?? 'admin.kill_read_refused', detail, state.httpStatus ?? 403, null, asOf);
    default:
      return unknown(detail, asOf);
  }
}

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

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export const TRADE_ALWAYS_ALLOWED = [
  'Reads (GET), such as open orders and balances',
  'orders.cancel over tRPC, and DELETE /api/v1/orders and /api/v1/orders/:id (cancel)',
  'POST /api/v1/positions/:id/close and POST /api/v1/futures/positions/close-all (close futures). DELETE /api/v1/positions/:id does not close.',
] as const;

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
