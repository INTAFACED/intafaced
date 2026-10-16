import { parseAmount, displayAmount, formatAmount } from '../../../shared/money';
import type {
  Approval,
  AssetAmount,
  CapKind,
  ControlProfile,
  Freshness,
  HaltScope,
  HaltStatus,
  Invitation,
  Member,
  MemberRole,
  MerchantRecord,
  Payment,
  PaymentEvent,
  PricingRule,
  Series,
  Settlement,
  Snapshot,
  TeamRole,
  Usage,
  UsageRow,
} from './schemas';
import { capKinds } from './schemas';

/**
 * Pure helpers for the merchant portal. Money here is only ever compared or formatted: amounts are decimal
 * strings, comparisons go through scaled bigint (`parseAmount`), and no amount becomes a JS number. The one
 * exception is a bar height, which is a ratio of two amounts used for geometry, never shown as money.
 */

/** A projection older than this is called stale on screen. A display rule only; it moves no money. */
export const STALE_AFTER_SECONDS = 300;

export const DAY_MS = 86_400_000;
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS));

/** The window the 30-day chart asks for: whole UTC days, today included (end is exclusive). */
export function seriesWindow(now: Date, days = 30): { from: string; to: string } {
  const today = utcDay(now);
  return { from: `${addDays(today, -(days - 1))}T00:00:00.000Z`, to: `${addDays(today, 1)}T00:00:00.000Z` };
}

export type Staleness = { kind: 'unknown' } | { kind: 'fresh'; lagSeconds: number } | { kind: 'stale'; lagSeconds: number };
export function staleness(freshness: Freshness): Staleness {
  if (freshness.asOf === null || freshness.lagSeconds === null) return { kind: 'unknown' };
  return freshness.lagSeconds > STALE_AFTER_SECONDS
    ? { kind: 'stale', lagSeconds: freshness.lagSeconds }
    : { kind: 'fresh', lagSeconds: freshness.lagSeconds };
}
/** `{ n, unit }` so the copy layer can pluralise; lag is a duration, not money. */
export function lagParts(seconds: number): { n: number; unit: 'seconds' | 'minutes' | 'hours' } {
  if (seconds < 60) return { n: seconds, unit: 'seconds' };
  if (seconds < 3600) return { n: Math.floor(seconds / 60), unit: 'minutes' };
  return { n: Math.floor(seconds / 3600), unit: 'hours' };
}

export function isZeroAmount(value: string): boolean {
  return parseAmount(value) === 0n;
}
/** Amounts of one asset as `1,234.50`; an empty list is "nothing yet", never a made-up zero. */
export function amountFor(list: readonly AssetAmount[], assetCode: string): string | null {
  return list.find((entry) => entry.assetCode === assetCode)?.amount ?? null;
}
export function assetsOf(snapshot: Snapshot): string[] {
  const all = new Set<string>();
  for (const list of [
    snapshot.captured,
    snapshot.refunded,
    snapshot.net,
    snapshot.averagePayment,
    snapshot.largestPayment,
    snapshot.feeRevenue,
  ])
    for (const entry of list) all.add(entry.assetCode);
  for (const row of snapshot.balances) all.add(row.assetCode);
  for (const row of snapshot.settlements) all.add(row.assetCode);
  return [...all].sort();
}
export const hasActivity = (snapshot: Snapshot) =>
  snapshot.paymentCount > 0 ||
  snapshot.captured.length > 0 ||
  snapshot.balances.some((b) => !isZeroAmount(b.available) || !isZeroAmount(b.clearing));
export function formatMoney(value: string, assetCode: string): string {
  return `${displayAmount(value)} ${assetCode}`;
}

export type Bar = { day: string; volume: string; pct: number; today: boolean };
/** One bar per UTC day for one asset, zero-filled so a quiet day is visible; heights are bigint ratios. */
export function bars(series: Series, assetCode: string, days: number, todayDay: string): Bar[] {
  const byDay = new Map<string, string>();
  for (const point of series.points) if (point.assetCode === assetCode) byDay.set(point.day, point.volume);
  const rows = Array.from({ length: days }, (_, i) => addDays(todayDay, -(days - 1 - i))).map((day) => ({
    day,
    volume: byDay.get(day) ?? '0',
  }));
  const max = rows.reduce((m, r) => (parseAmount(r.volume) > m ? parseAmount(r.volume) : m), 0n);
  return rows.map((r) => ({
    ...r,
    today: r.day === todayDay,
    pct: max === 0n ? 0 : Number((parseAmount(r.volume) * 1000n) / max) / 10,
  }));
}
export const seriesAssets = (series: Series) => [...new Set(series.points.map((p) => p.assetCode))].sort();

/** Share of payments in each status, as whole-number percentages that are only used to size a bar. */
export function mixShares(mix: Snapshot['statusMix']): Array<{ status: string; count: number; pct: number }> {
  const total = mix.reduce((n, row) => n + row.count, 0);
  return mix.filter((row) => row.count > 0).map((row) => ({ ...row, pct: total === 0 ? 0 : Math.round((row.count / total) * 100) }));
}

// ---- onboarding -----------------------------------------------------------------------------------------

export type StepState = 'todo' | 'current' | 'done' | 'waiting';
export type Steps = {
  business: StepState;
  verification: StepState;
  payout: StepState;
  current: 0 | 1 | 2;
  sandboxReady: boolean;
  liveWaiting: boolean;
};
/**
 * Progress comes from the service, never from the browser: a merchant record means step 1 is done, a KYB
 * status past `none` means step 2 has been submitted. A payout destination cannot be read back (the service
 * publishes no read), so step 3 is only "done" for what this visit just saved.
 */
export function onboardingSteps(merchant: MerchantRecord | null, kybStatus: string | null, destinationSaved: boolean): Steps {
  const business: StepState = merchant ? 'done' : 'current';
  const kyb = kybStatus ?? merchant?.kybStatus ?? 'none';
  const verification: StepState = !merchant ? 'todo' : kyb === 'approved' ? 'done' : kyb === 'pending' ? 'waiting' : 'current';
  const payout: StepState = !merchant ? 'todo' : destinationSaved ? 'done' : verification === 'current' ? 'todo' : 'current';
  const current = !merchant ? 0 : verification === 'current' || verification === 'waiting' ? 1 : 2;
  return {
    business,
    verification,
    payout,
    current: current as 0 | 1 | 2,
    sandboxReady: Boolean(merchant) && destinationSaved,
    liveWaiting: Boolean(merchant) && kyb !== 'approved',
  };
}

export type BusinessForm = {
  legalName: string;
  /** Optional trading name. Left blank, the service shows the legal name. */
  displayName: string;
  country: string;
  businessType: string;
  website: string;
  contactEmail: string;
  expectedVolume: string;
};
export const emptyBusiness: BusinessForm = {
  legalName: '',
  displayName: '',
  country: '',
  businessType: '',
  website: '',
  contactEmail: '',
  expectedVolume: '',
};
export type BusinessErrors = Partial<Record<keyof BusinessForm, 'required' | 'country' | 'website' | 'email' | 'volume' | 'name'>>;
/** The service refuses a name over 120 characters or holding a control or invisible formatting character (not U+200D); say so before sending. Same class as the service and database. */
// eslint-disable-next-line no-control-regex -- the point of this pattern is to match control characters
const BAD_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
const nameProblem = (value: string) => [...value.trim()].length > 120 || BAD_NAME.test(value.trim());
export function validateBusiness(form: BusinessForm): BusinessErrors {
  const errors: BusinessErrors = {};
  if (form.legalName.trim().length < 2) errors.legalName = 'required';
  else if (nameProblem(form.legalName)) errors.legalName = 'name';
  if (nameProblem(form.displayName)) errors.displayName = 'name';
  if (!/^[A-Za-z]{2}$/.test(form.country.trim())) errors.country = 'country';
  if (form.businessType.trim().length < 2) errors.businessType = 'required';
  if (form.website.trim()) {
    try {
      const url = new URL(form.website.trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') errors.website = 'website';
    } catch {
      errors.website = 'website';
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contactEmail.trim())) errors.contactEmail = 'email';
  // Declared volume is free text for a person to read ("about 40 payments a month"); a number is not required.
  if (form.expectedVolume.length > 200) errors.expectedVolume = 'volume';
  return errors;
}
export function businessDetails(form: BusinessForm): Record<string, string> {
  return {
    legalName: form.legalName.trim(),
    country: form.country.trim().toUpperCase(),
    businessType: form.businessType.trim(),
    ...(form.website.trim() ? { website: form.website.trim() } : {}),
    contactEmail: form.contactEmail.trim(),
    ...(form.expectedVolume.trim() ? { declaredExpectedVolume: form.expectedVolume.trim() } : {}),
  };
}

/** The two names the service stores on the merchant. The display name is sent only when the person typed one. */
export function merchantNames(form: BusinessForm): { legalName: string; displayName?: string } {
  return {
    legalName: form.legalName.trim(),
    ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
  };
}

/** Shape checks the service repeats: a crypto destination is an EVM address; a bank one is an IBAN or IFSC. */
export function destinationShapeOk(kind: 'crypto' | 'bank', ref: string): boolean {
  const value = ref.trim();
  if (kind === 'crypto') return /^0x[0-9a-fA-F]{40}$/.test(value);
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(compact)) return true;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact) || compact.length < 15 || compact.length > 34) return false;
  let remainder = 0;
  for (const ch of compact.slice(4) + compact.slice(0, 4)) {
    const digits = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}
export const railKind = (railId: string): 'crypto' | 'bank' => (railId.startsWith('crypto') ? 'crypto' : 'bank');

// ---- team ----------------------------------------------------------------------------------------------

export const memberActions = (me: MemberRole | null, member: Member) => {
  const manage = me === 'owner' || me === 'admin';
  const self = member.role === 'owner';
  const adminTarget = member.role === 'admin' && me !== 'owner';
  const canChange = manage && !self && member.status === 'active' && !adminTarget;
  return { canChange, canRemove: canChange, reason: !manage ? 'role' : self ? 'owner' : adminTarget ? 'admin' : null } as const;
};
/** Roles this person may hand out: only the owner may grant admin. */
export const grantableRoles = (me: MemberRole | null): readonly TeamRole[] =>
  me === 'owner' ? ['admin', 'finance', 'developer', 'viewer'] : me === 'admin' ? ['finance', 'developer', 'viewer'] : [];
export const pendingFor = (invitations: readonly Invitation[]) => invitations.length;

// ---- shared --------------------------------------------------------------------------------------------

export function newRequestId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Digits only, at most 18 places, no sign: what the service accepts as a threshold. */
export const isDecimalThreshold = (value: string) => /^\d+(\.\d{1,18})?$/.test(value.trim());

export function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}
export function nextDueSoonest<T extends { responseDueAt: string | null }>(rows: readonly T[]): T | null {
  const dated = rows.filter((r) => r.responseDueAt !== null).sort((a, b) => Date.parse(a.responseDueAt!) - Date.parse(b.responseDueAt!));
  return dated[0] ?? null;
}

// ---- payments (P06, P07) -------------------------------------------------------------------------------

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);

/** Page sizes the list reads accept: the service takes a limit up to 200 and no cursor. */
export const LIST_LIMITS = [25, 50, 100, 200] as const;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;
export const nextLimit = (current: number): number => LIST_LIMITS.find((n) => n > current) ?? MAX_LIMIT;
export const readLimit = (raw: string): number => {
  const n = Number(raw);
  return (LIST_LIMITS as readonly number[]).includes(n) ? n : DEFAULT_LIMIT;
};

export const sortKeys = ['newest', 'oldest', 'largest', 'smallest'] as const;
export type SortKey = (typeof sortKeys)[number];
export const readSort = (raw: string): SortKey => ((sortKeys as readonly string[]).includes(raw) ? (raw as SortKey) : 'newest');

export type PaymentFilters = { q: string; asset: string; from: string; to: string };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (day: string): number | null => (DAY_RE.test(day) ? Date.parse(`${day}T00:00:00.000Z`) : null);

/** Search looks only at what is already on screen: ids, references and method names. Case does not matter. */
export const matchesSearch = (fields: ReadonlyArray<string | null | undefined>, q: string): boolean => {
  const needle = q.trim().toLowerCase();
  return needle === '' || fields.some((f) => (f ?? '').toLowerCase().includes(needle));
};

export function filterPayments(rows: readonly Payment[], f: PaymentFilters): Payment[] {
  const from = dayStart(f.from);
  const to = dayStart(f.to);
  return rows.filter((row) => {
    if (f.asset && row.assetId !== f.asset) return false;
    const at = Date.parse(row.createdAt);
    if (from !== null && at < from) return false;
    if (to !== null && at >= to + DAY_MS) return false;
    return matchesSearch([row.id, row.railRef, row.method, row.railAdapter], f.q);
  });
}
const compareAmounts = (a: string, b: string) => {
  const x = parseAmount(a);
  const y = parseAmount(b);
  return x === y ? 0 : x < y ? -1 : 1;
};
export function sortRows<T>(rows: readonly T[], sort: SortKey, at: (row: T) => string, amountOf: (row: T) => string): T[] {
  const out = [...rows];
  const byTime = (a: T, b: T) => Date.parse(at(a)) - Date.parse(at(b));
  switch (sort) {
    case 'newest':
      return out.sort((a, b) => byTime(b, a));
    case 'oldest':
      return out.sort(byTime);
    case 'largest':
      return out.sort((a, b) => compareAmounts(amountOf(b), amountOf(a)) || byTime(b, a));
    case 'smallest':
      return out.sort((a, b) => compareAmounts(amountOf(a), amountOf(b)) || byTime(b, a));
  }
}
export const assetsIn = (rows: ReadonlyArray<{ assetId: string }>): string[] => [...new Set(rows.map((r) => r.assetId))].sort();

/** Share of payments in the period that did not fail. `null` when there were none: no payments is not a 100% rate. */
export function successRate(mix: Snapshot['statusMix']): { total: number; failed: number; pct: number | null } {
  const total = mix.reduce((n, row) => n + row.count, 0);
  const failed = mix.find((row) => row.status === 'failed')?.count ?? 0;
  return { total, failed, pct: total === 0 ? null : Math.round(((total - failed) * 100) / total) };
}
export const countOf = (mix: Snapshot['statusMix'], status: string) => mix.find((row) => row.status === status)?.count ?? 0;

/** What can still be refunded: captured minus refunded, never below zero. */
export function refundable(payment: Pick<Payment, 'capturedAmount' | 'refundedAmount'>): string {
  const left = parseAmount(payment.capturedAmount) - parseAmount(payment.refundedAmount);
  return formatAmount(left > 0n ? left : 0n);
}

// ---- payment history -> plain timeline -----------------------------------------------------------------

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
/** Event payloads are free-form. An amount is shown only if it is an exact decimal; anything else is left out rather than risk the page. */
const money = (value: unknown): string | null => {
  const raw = text(value);
  return raw !== null && /^\d+(\.\d{1,18})?$/.test(raw) ? raw : null;
};
export type PaymentStep = {
  at: string;
  kind: 'created' | 'authorized' | 'captured' | 'settled' | 'refunded' | 'refund_reversed' | 'disputed' | 'failed';
  amount: string | null;
  refundId: string | null;
  settlementId: string | null;
};
/**
 * Only a fixed list of events is shown, and only a few named fields of each. The history also carries the payer's
 * instrument and rail internals; none of that reaches the screen. A failure shows no code, because a rail's code is not an explanation.
 */
export function paymentSteps(events: readonly PaymentEvent[]): PaymentStep[] {
  const out: PaymentStep[] = [];
  for (const e of events) {
    const kind = (
      {
        created: 'created',
        authorized: 'authorized',
        captured: 'captured',
        settled: 'settled',
        refunded: 'refunded',
        'refund.reversed': 'refund_reversed',
        disputed: 'disputed',
        failed: 'failed',
      } as const
    )[e.event as 'created'];
    if (!kind) continue;
    out.push({
      at: e.ts,
      kind,
      amount: money(e.payload.amount),
      refundId: text(e.payload.refundId),
      settlementId: text(e.payload.settlementId),
    });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export type PaymentRefund = { refundId: string; amount: string | null; state: 'completed' | 'in_progress' | 'reversed'; at: string };
/** Refunds by their own id: posted to the books, then confirmed by the rail (completed) or put back (reversed). */
export function paymentRefunds(events: readonly PaymentEvent[]): PaymentRefund[] {
  const byId = new Map<string, PaymentRefund>();
  for (const e of [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    if (e.event !== 'refund.posted' && e.event !== 'refunded' && e.event !== 'refund.reversed') continue;
    const refundId = text(e.payload.refundId);
    if (!refundId) continue;
    const state = e.event === 'refunded' ? 'completed' : e.event === 'refund.reversed' ? 'reversed' : 'in_progress';
    const before = byId.get(refundId);
    byId.set(refundId, { refundId, amount: money(e.payload.amount) ?? before?.amount ?? null, state, at: before?.at ?? e.ts });
  }
  return [...byId.values()];
}

/** The few identifiers worth copying. The payer's reference is the merchant's own, supplied when the payment was made. */
export function paymentLinks(events: readonly PaymentEvent[]) {
  const find = (name: string) => events.find((e) => e.event === name);
  const settled = find('settled') ?? find('settlement.included');
  return {
    customerRef: text(find('created')?.payload.customerRef),
    ledgerTxId: text(find('captured')?.payload.ledgerTxId),
    settlementId: text(settled?.payload.settlementId),
    disputeId: text(find('disputed')?.payload.disputeId),
  };
}

// ---- settlements and payouts (P26-P30) -----------------------------------------------------------------

/** Gross less fees must equal net, to the last decimal. A statement that does not add up is flagged, not smoothed over. */
export function statementTies(s: Pick<Settlement, 'gross' | 'fees' | 'net'>): boolean {
  return parseAmount(s.gross) - parseAmount(s.fees) === parseAmount(s.net);
}

export type PayoutState = 'not_ready' | 'unknown' | 'ready' | 'awaiting_approval' | 'approved' | 'rejected' | 'paid_out' | 'failed';
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

// ---- approvals (P31) -----------------------------------------------------------------------------------

export type Span = { n: number; unit: 'minutes' | 'hours' | 'days' };
/** A length of time in the largest sensible unit. Under a minute reads as zero minutes, which the copy turns into "just now". */
export function spanParts(ms: number): Span {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return { n: minutes, unit: 'minutes' };
  if (minutes < 60 * 48) return { n: Math.floor(minutes / 60), unit: 'hours' };
  return { n: Math.floor(minutes / 1440), unit: 'days' };
}

export type RoleLike = MemberRole | null;
/** Owner, admin and finance can decide payouts. Developers and viewers cannot. A role we could not read is left to the service. */
export const roleMayDecide = (role: RoleLike) => role === null || role === 'owner' || role === 'admin' || role === 'finance';
export type DecisionBlock = 'status' | 'checked' | 'expired' | 'own' | 'role' | null;
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
export function usagePct(used: string, limit: string): number {
  const u = parseAmount(used);
  const l = parseAmount(limit);
  if (l === 0n) return 100;
  if (u >= l) return 100;
  return Number((u * 1000n) / l) / 10;
}
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

// ---- operation pauses (B11) ----------------------------------------------------------------------------

export type ActiveHalt = { scope: HaltScope; level: 'global' | 'merchant' | 'rail'; railId?: string; changedAt: string | null };
/** Pauses that apply to the given operations. A store that could not be read counts as paused for all of them. */
export function activeHalts(status: HaltStatus, scopes: readonly HaltScope[]): { unreadable: boolean; halts: ActiveHalt[] } {
  if (!status.readable) return { unreadable: true, halts: [] };
  return {
    unreadable: false,
    halts: status.states
      .filter((s) => s.halted && scopes.includes(s.scope))
      .map((s) => {
        if (s.target.level === 'rail') return { scope: s.scope, level: 'rail' as const, railId: s.target.railId, changedAt: s.changedAt };
        if (s.target.level === 'merchant') return { scope: s.scope, level: 'merchant' as const, changedAt: s.changedAt };
        return { scope: s.scope, level: 'global' as const, changedAt: s.changedAt };
      }),
  };
}
