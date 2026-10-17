import { formatAmount, parseAmount } from '../../../../shared/money';
import { dec, toFixedString } from '../../../../data/decimal';
import type { StatementLine, StatementPage } from './schemas';
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

// ---- shared by the money pages ----------------------------------------------------------------------

/** A decimal string rounded to `places` for a headline figure (half up, by integer arithmetic). Never a JS number. */
export function roundedDecimal(value: string, places: number): string {
  const scaled = dec(value);
  return scaled === null ? '0' : toFixedString(scaled, places);
}

/** True when the exact amount has digits beyond `places`, so a compact figure would hide something. */
export const hasHiddenDigits = (value: string, places: number): boolean => /[1-9]/.test((value.split('.')[1] ?? '').slice(places));

/** Exact subtraction, floored at zero: how much of a captured payment can still be refunded. */
export function refundableAmount(captured: string, refunded: string): string {
  const left = parseAmount(captured) - parseAmount(refunded);
  return formatAmount(left > 0n ? left : 0n);
}

/** Per-asset sums by integer arithmetic. Two assets are never added together. */
export function sumByAsset(rows: ReadonlyArray<{ assetCode: string; amount: string }>): AssetAmount[] {
  const by = new Map<string, bigint>();
  for (const r of rows) by.set(r.assetCode, (by.get(r.assetCode) ?? 0n) + parseAmount(r.amount));
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([assetCode, v]) => ({ assetCode, amount: formatAmount(v) }));
}

// ---- where a payout goes ----------------------------------------------------------------------------

export type RailWords = 'crypto' | 'bank' | 'other';
/** The kind of destination a rail takes. The service holds the same map; this only picks the words and the form. */
export function destinationKindOfRail(railId: string): 'crypto' | 'bank' {
  return railId === 'crypto-native' ? 'crypto' : 'bank';
}
export const kindWords = (kind: string): RailWords => (kind === 'crypto' ? 'crypto' : kind === 'bank' ? 'bank' : 'other');

/** The one Settlement-like and Payout-like row the lists share. */
export type PayoutLike = { id: string; status: 'pending' | 'posted' | 'paid_out' | 'failed' };

/** The newest approval per settlement, so a list can say "waiting for approval" without a second read per row. */
export function approvalsBySettlement(approvals: readonly Approval[]): Map<string, Approval> {
  const by = new Map<string, Approval>();
  for (const a of [...approvals].sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt))) by.set(a.settlementId, a);
  return by;
}

export function payoutRowState(item: PayoutLike, approvals: ReadonlyMap<string, Approval> | null): PayoutState {
  return payoutState({ status: item.status }, approvals?.get(item.id) ?? null, approvals !== null);
}

// ---- approvals ---------------------------------------------------------------------------------------

export const ageOf = (a: Pick<Approval, 'createdAt'>, now: number) => Math.max(0, now - Date.parse(a.createdAt));
/** Pending and ending within a day of `now`. */
export const expiresToday = (a: Pick<Approval, 'status' | 'expiresAt'>, now: number) => {
  const left = Date.parse(a.expiresAt) - now;
  return a.status === 'pending' && left > 0 && left <= 86_400_000;
};
/** "Waiting for approval from Finance": who can decide it. */
export const waitingFrom = (a: Pick<Approval, 'status' | 'checkerUserId'>): 'team' | 'intafaced' | null =>
  a.status !== 'pending' ? null : a.checkerUserId !== null ? 'intafaced' : 'team';

// ---- the statement -----------------------------------------------------------------------------------

export type RunningView = { shown: true } | { shown: false; reason: 'no_opening' | 'order_ambiguous' | 'none' };
/**
 * A running balance is drawn only when every line in view followed ledger order. One ambiguous or opening-less line
 * hides the column for the whole range, and the reason is said in words.
 */
export function runningView(lines: readonly Pick<StatementLine, 'runningOrder' | 'runningReason' | 'runningClearing' | 'runningProceeds'>[]): RunningView {
  if (lines.length === 0) return { shown: false, reason: 'none' };
  const bad = lines.find((l) => l.runningOrder !== 'clear' || l.runningReason);
  if (bad) return { shown: false, reason: bad.runningReason === 'no_opening' ? 'no_opening' : 'order_ambiguous' };
  return lines.every((l) => l.runningClearing != null || l.runningProceeds != null) ? { shown: true } : { shown: false, reason: 'no_opening' };
}

/**
 * +1 when a line adds to the account it names, -1 when it takes away. In this ledger a debit raises these balances and
 * a credit lowers them (the service applies them the same way when it builds the running balance). Other accounts
 * have no sign shown.
 */
export const lineSign = (l: Pick<StatementLine, 'direction' | 'account'>): 1 | -1 | 0 =>
  l.account !== 'clearing' && l.account !== 'proceeds' ? 0 : l.direction === 'debit' ? 1 : -1;

export type TieView = 'matches' | 'differs' | 'unknown';
/** Does the statement agree with the balances? Any account that differs wins; any unknown makes the answer unknown. */
export function tieView(tie: StatementPage['tieOut'] | undefined, assetId: string): TieView {
  const rows = tie?.accounts.filter((a) => !assetId || a.assetId === assetId) ?? [];
  if (rows.length === 0) return 'unknown';
  const flags = rows.flatMap((a) => [a.clearing.matches, a.proceeds.matches]);
  if (flags.includes(false)) return 'differs';
  return flags.every((f) => f === true) ? 'matches' : 'unknown';
}

/** The default statement window: the last 30 whole days, ending tomorrow's midnight UTC. Both bounds are required by the service. */
export function defaultStatementRange(now: number): { from: string; to: string } {
  const day = 86_400_000;
  const start = Math.floor(now / day) * day;
  return { from: new Date(start - 29 * day).toISOString(), to: new Date(start + day).toISOString() };
}
export const STATEMENT_MAX_DAYS = 92;
export const statementRangeTooWide = (r: { from?: string; to?: string }) =>
  r.from && r.to ? Date.parse(r.to) - Date.parse(r.from) > STATEMENT_MAX_DAYS * 86_400_000 : false;

// ---- refunds -----------------------------------------------------------------------------------------

/** A refund amount a merchant typed, checked against what is left to refund. `null` means fine. */
export function refundAmountProblem(typed: string, refundable: string): 'empty' | 'format' | 'zero' | 'over' | null {
  const text = typed.trim();
  if (!text) return 'empty';
  if (!/^\d+(\.\d{1,18})?$/.test(text)) return 'format';
  const v = parseAmount(text);
  if (v <= 0n) return 'zero';
  return v > parseAmount(refundable) ? 'over' : null;
}

/** Refund rate as a percentage with two places, refunded over captured, by integer arithmetic. Null when nothing was captured. */
export function refundRate(refunded: string, captured: string): string | null {
  const cap = parseAmount(captured);
  if (cap <= 0n) return null;
  const hundredths = (parseAmount(refunded) * 10_000n + cap / 2n) / cap;
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`;
}

// ---- payout form -------------------------------------------------------------------------------------

export type PayoutBlock = 'nothing' | 'paused' | 'kyb' | 'noDestination' | 'overCap' | null;
/**
 * Why a payout cannot be started now, in the order a merchant would fix it. The service checks every one again, so
 * this only decides what to explain before the button, never what is allowed.
 */
export function payoutBlock(input: {
  settlement: { net: string; assetId: string } | null;
  paused: boolean;
  kybApproved: boolean | null;
  destinationCount: number | null;
  remaining: string | null;
}): PayoutBlock {
  if (!input.settlement) return 'nothing';
  if (input.paused) return 'paused';
  if (input.kybApproved === false) return 'kyb';
  if (input.destinationCount === 0) return 'noDestination';
  if (input.remaining !== null && parseAmount(input.settlement.net) > parseAmount(input.remaining)) return 'overCap';
  return null;
}

/** What is left today of the daily payout limit for one asset, or null when none is set or no usage was read. */
export function payoutHeadroom(usage: Pick<Usage, 'rows'> | null, assetId: string): { limit: string; remaining: string | null } | null {
  const row = usage?.rows.find((r) => r.kind === 'daily_payout' && r.assetCode === assetId);
  return row ? { limit: row.limit, remaining: row.remaining } : null;
}

// ---- payout timeline ---------------------------------------------------------------------------------

export type TrailEvent = {
  key: string;
  at: string | null;
  kind: string;
  who?: string;
  destination?: string | null;
  failure?: string | null;
  terminal?: boolean;
};

/**
 * One chronological trail, oldest first, with the final state last. Events whose time was not recorded keep the order
 * the service gave them and sit after the timed ones they follow. A payout that was rejected once and later paid ends
 * on "Paid out", never on "Rejected".
 */
export function orderTrail(events: readonly TrailEvent[], finalState: 'paid_out' | 'failed' | 'other'): TrailEvent[] {
  const indexed = events.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => {
    const ta = a.e.at ? Date.parse(a.e.at) : null;
    const tb = b.e.at ? Date.parse(b.e.at) : null;
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    return a.i - b.i;
  });
  const out = indexed.map((x) => x.e);
  if (finalState === 'other') return out;
  const finals = out.filter((e) => e.terminal);
  const rest = out.filter((e) => !e.terminal);
  return [...rest, ...finals];
}
