import { parseAmount } from '../../../../shared/money';
import type {
  Approval,
  AssetAmount,
  CapKind,
  ControlProfile,
  Freshness,
  MemberRole,
  PricingRule,
  Settlement,
  Usage,
  UsageRow,
} from '../schemas';
import { capKinds } from '../schemas';
import { shortId, type PayoutState, type DecisionBlock, usagePct } from '../model';

/** Amounts of one asset as `1,234.50`; an empty list is "nothing yet", never a made-up zero. */
export function amountFor(list: readonly AssetAmount[], assetCode: string): string | null {
  return list.find((entry) => entry.assetCode === assetCode)?.amount ?? null;
}

// ---- settlements and payouts (P26-P30) -----------------------------------------------------------------

/** Gross less fees must equal net, to the last decimal. A statement that does not add up is flagged, not smoothed over. */
export function statementTies(s: Pick<Settlement, 'gross' | 'fees' | 'net'>): boolean {
  return parseAmount(s.gross) - parseAmount(s.fees) === parseAmount(s.net);
}

export const payoutStates: readonly PayoutState[] = ['ready', 'awaiting_approval', 'approved', 'rejected', 'paid_out', 'failed', 'unknown'];

/** The newest approval request for one settlement, or null. */
export function latestApproval(approvals: readonly Approval[], settlementId: string): Approval | null {
  return (
    approvals.filter((a) => a.settlementId === settlementId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
  );
}

/**
 * A payout has no record of its own: it is the second half of a settlement. Its state is read from the settlement and
 * the newest approval request. A voided or expired request counts for nothing, so the payout is back to "ready".
 */
export function payoutState(
  settlement: Pick<Settlement, 'status'>,
  approval: Pick<Approval, 'status'> | null,
  /** False when the approvals could not be read: a posted settlement is then "unknown", never "ready". */
  approvalsKnown = true,
): PayoutState {
  if (settlement.status === 'paid_out') return 'paid_out';
  if (settlement.status === 'failed') return 'failed';
  if (settlement.status === 'pending') return 'not_ready';
  if (!approvalsKnown) return 'unknown';
  if (approval?.status === 'pending') return 'awaiting_approval';
  if (approval?.status === 'approved' || approval?.status === 'consumed') return 'approved';
  if (approval?.status === 'rejected') return 'rejected';
  return 'ready';
}

export type PayoutRow = {
  settlementId: string;
  window: string;
  assetId: string;
  amount: string;
  state: PayoutState;
  approval: Approval | null;
  payoutMethod: string | null;
  payoutRef: string | null;
};

/** `approvals` is null when they could not be read. */
export function payoutRows(settlements: readonly Settlement[], approvals: readonly Approval[] | null): PayoutRow[] {
  return settlements
    .filter((s) => s.status !== 'pending')
    .map((s) => {
      const approval = approvals ? latestApproval(approvals, s.id) : null;
      return {
        settlementId: s.id,
        window: s.window,
        assetId: s.assetId,
        amount: s.net,
        state: payoutState(s, approval, approvals !== null),
        approval,
        payoutMethod: s.payoutMethod,
        payoutRef: s.payoutRef,
      };
    });
}

export type RoleLike = MemberRole | null;

/** Owner, admin and finance can decide payouts. Developers and viewers cannot. A role we could not read is left to the service. */
export const roleMayDecide = (role: RoleLike) => role === null || role === 'owner' || role === 'admin' || role === 'finance';

/** A teammate has already approved it and it waits for INTAFACED's sign-off: nothing is left for this person to decide. */
export const isCheckedPending = (a: Pick<Approval, 'status' | 'checkerUserId'>) => a.status === 'pending' && a.checkerUserId !== null;

/** Why this person cannot decide this request, or null when they can. The service enforces all of it again. */
export function decisionBlock(
  a: Pick<Approval, 'status' | 'makerUserId' | 'checkerUserId' | 'expiresAt'>,
  me: string | null,
  role: RoleLike,
  now: number,
): DecisionBlock {
  if (a.status !== 'pending') return 'status';
  if (isCheckedPending(a)) return 'checked';
  if (Date.parse(a.expiresAt) <= now) return 'expired';
  if (me !== null && a.makerUserId === me) return 'own';
  if (!roleMayDecide(role)) return 'role';
  return null;
}

export function approvalSummary(rows: readonly Approval[], me: string | null, now: number) {
  const pending = rows.filter((a) => a.status === 'pending');
  // A request a teammate already approved is waiting on INTAFACED, not on anyone in the team.
  const open = pending.filter((a) => !isCheckedPending(a));
  const oldest = [...pending].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
  const next =
    [...pending].filter((a) => Date.parse(a.expiresAt) > now).sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))[0] ?? null;
  return {
    waiting: pending.length,
    mine: open.filter((a) => me !== null && a.makerUserId === me).length,
    forOthers: open.filter((a) => me === null || a.makerUserId !== me).length,
    signoff: pending.length - open.length,
    oldest,
    next,
  };
}

/** Whether a decision the service answered actually took effect. A request that was voided or expired in the meantime did not. */
export function decisionLanded(decision: 'approve' | 'reject', status: Approval['status']): boolean {
  return decision === 'approve' ? status === 'approved' || status === 'pending' || status === 'consumed' : status === 'rejected';
}

/** A person's name where the portal has one (from the team list), otherwise a short id. */
export function actorName(id: string, names: ReadonlyMap<string, string>): string {
  return names.get(id) ?? shortId(id);
}

export const minReasonOk = (reason: string) => reason.trim().length >= 3 && reason.trim().length <= 500;

// ---- limits (P37) --------------------------------------------------------------------------------------

export type LimitRow = {
  kind: CapKind;
  configured: boolean;
  assetCode: string | null;
  limit: string | null;
  used: string | null;
  remaining: string | null;
  resetsAt: string | null;
  /** 0 to 100, only used to size a bar; null when there is no usage to show. */
  pct: number | null;
};

/** Every kind of limit appears, in a fixed order; one nobody configured says so instead of being left out. */
export function limitRows(usage: Pick<Usage, 'rows'> | null, profile: Pick<ControlProfile, 'caps'> | null): LimitRow[] {
  const rows: LimitRow[] = [];
  for (const kind of capKinds) {
    const fromUsage: readonly UsageRow[] = usage?.rows.filter((r) => r.kind === kind) ?? [];
    if (fromUsage.length > 0) {
      for (const r of fromUsage)
        rows.push({
          kind,
          configured: true,
          assetCode: r.assetCode,
          limit: r.limit,
          used: r.used,
          remaining: r.remaining,
          resetsAt: r.resetsAt,
          pct: r.used === null ? null : usagePct(r.used, r.limit),
        });
      continue;
    }
    const caps = profile?.caps?.filter((c) => c.kind === kind) ?? [];
    if (caps.length > 0) {
      for (const c of caps)
        rows.push({
          kind,
          configured: true,
          assetCode: 'assetCode' in c ? c.assetCode : null,
          limit: String(c.limit),
          used: null,
          remaining: null,
          resetsAt: null,
          pct: null,
        });
      continue;
    }
    rows.push({ kind, configured: false, assetCode: null, limit: null, used: null, remaining: null, resetsAt: null, pct: null });
  }
  return rows;
}

export function closestToLimit(rows: readonly LimitRow[]): LimitRow | null {
  return rows.filter((r) => r.pct !== null).sort((a, b) => b.pct! - a.pct!)[0] ?? null;
}

/** "As of" for a read that only carries a time: the lag is how long ago it was computed. */
export function freshnessAt(asOf: string, now: number): Freshness {
  const at = Date.parse(asOf);
  return Number.isFinite(at) ? { asOf, lagSeconds: Math.max(0, Math.round((now - at) / 1000)) } : { asOf: null, lagSeconds: null };
}

// ---- pricing (P36) -------------------------------------------------------------------------------------

/** Basis points as a percentage with two places, by integer arithmetic: 150 is "1.50%". */
export const bpsPercent = (bps: number): string => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;

export const isCalcAmount = (value: string) => /^\d+(\.\d{1,18})?$/.test(value.trim()) && /[1-9]/.test(value);

export function pricingAssets(rules: readonly PricingRule[] | null): string[] {
  return rules ? [...new Set(rules.map((r) => r.assetCode))].sort() : [];
}
