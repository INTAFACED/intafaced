import { parseAmount, formatAmount } from '../../../shared/money';
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

export const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS));

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

/** The service refuses a name over 120 characters or holding a control or invisible formatting character (not U+200D); say so before sending. Same class as the service and database. */
// eslint-disable-next-line no-control-regex -- the point of this pattern is to match control characters
const BAD_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;

export const nameProblem = (value: string) => [...value.trim()].length > 120 || BAD_NAME.test(value.trim());

export const pendingFor = (invitations: readonly Invitation[]) => invitations.length;

// ---- shared --------------------------------------------------------------------------------------------

/** A fresh request id. It is the key that makes a retry safe, so it is never made without randomness: no crypto, no id. */
export function newRequestId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (!c?.getRandomValues) throw new Error('This browser cannot make a safe request id.');
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
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

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const dayStart = (day: string): number | null => (DAY_RE.test(day) ? Date.parse(`${day}T00:00:00.000Z`) : null);

/** Search looks only at what is already on screen: ids, references and method names. Case does not matter. */
export const matchesSearch = (fields: ReadonlyArray<string | null | undefined>, q: string): boolean => {
  const needle = q.trim().toLowerCase();
  return needle === '' || fields.some((f) => (f ?? '').toLowerCase().includes(needle));
};

export const compareAmounts = (a: string, b: string) => {
  const x = parseAmount(a);
  const y = parseAmount(b);
  return x === y ? 0 : x < y ? -1 : 1;
};

export const assetsIn = (rows: ReadonlyArray<{ assetId: string }>): string[] => [...new Set(rows.map((r) => r.assetId))].sort();

// ---- payment history -> plain timeline -----------------------------------------------------------------

export const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** Event payloads are free-form. An amount is shown only if it is an exact decimal; anything else is left out rather than risk the page. */
const money = (value: unknown): string | null => {
  const raw = text(value);
  return raw !== null && /^\d+(\.\d{1,18})?$/.test(raw) ? raw : null;
};

export type PaymentStep = {
  at: string;
  kind: 'created' | 'authorized' | 'captured' | 'settled' | 'refunded' | 'refund_reversed' | 'disputed' | 'failed' | 'held_name';
  amount: string | null;
  refundId: string | null;
  settlementId: string | null;
};

/**
 * Only a fixed list of events is shown, and only a few named fields of each. The history also carries the payer's
 * instrument and rail internals; none of that reaches the screen. A failure shows no code, because a rail's code is not an explanation.
 */
export function historyPayload(event: PaymentEvent): Record<string, unknown> {
  return 'payload' in event ? event.payload : {};
}

export function historyAmount(event: PaymentEvent): string | null {
  if ('amount' in event && !('payload' in event)) return money(event.amount);
  return money(historyPayload(event).amount);
}

export type PaymentRefund = { refundId: string; amount: string | null; state: 'completed' | 'in_progress' | 'reversed'; at: string };

/** Refunds by their own id: posted to the books, then confirmed by the rail (completed) or put back (reversed). */
export function paymentRefunds(events: readonly PaymentEvent[]): PaymentRefund[] {
  const byId = new Map<string, PaymentRefund>();
  for (const e of [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    if (e.event !== 'refund.posted' && e.event !== 'refunded' && e.event !== 'refund.reversed') continue;
    const payload = historyPayload(e);
    const refundId = text(payload.refundId);
    if (!refundId) continue;
    const state = e.event === 'refunded' ? 'completed' : e.event === 'refund.reversed' ? 'reversed' : 'in_progress';
    const before = byId.get(refundId);
    byId.set(refundId, { refundId, amount: historyAmount(e) ?? before?.amount ?? null, state, at: before?.at ?? e.ts });
  }
  return [...byId.values()];
}

/** The few identifiers worth copying. The payer's reference is the merchant's own, supplied when the payment was made. */
export function paymentLinks(events: readonly PaymentEvent[]) {
  const find = (name: string) => events.find((e) => e.event === name);
  const settled = find('settled') ?? find('settlement.included');
  return {
    customerRef: text(find('created') ? historyPayload(find('created')!).customerRef : null),
    ledgerTxId: text(find('captured') ? historyPayload(find('captured')!).ledgerTxId : null),
    settlementId: text(settled ? historyPayload(settled).settlementId : null),
    disputeId: text(find('disputed') ? historyPayload(find('disputed')!).disputeId : null),
  };
}

/** Why a bank transfer is held for a review of the name it came from (RC-merchant-09), from the code svc-pay records. */
export type NameHoldReason = 'mismatch' | 'missing' | 'rule_unset';
const NAME_HOLD_REASONS: Readonly<Record<string, NameHoldReason>> = {
  'pay.payer_name_mismatch': 'mismatch',
  'pay.payer_name_missing': 'missing',
  'pay.name_match_rule_unset': 'rule_unset',
};

/**
 * The payment's payer-name hold, when it is still waiting: its reason from the `payer_name.held` event. Nothing was taken
 * while it waits, so a payment that went on to be taken (or failed) is not shown as held. Names are never in the event.
 */
export function nameHold(status: string, events: readonly PaymentEvent[]): NameHoldReason | null {
  if (status !== 'created') return null;
  const held = events.find((e) => e.event === 'payer_name.held');
  const reason = held ? historyPayload(held).reason : null;
  return typeof reason === 'string' && Object.hasOwn(NAME_HOLD_REASONS, reason) ? NAME_HOLD_REASONS[reason]! : null;
}

/**
 * While a crypto payment waits for its transfers to be final: how deep the furthest-behind transfer is and how deep it
 * must be, from the newest rail result. Null once the payment moved on, or when the rail said nothing about it.
 */
export function waitingConfirmations(status: string, events: readonly PaymentEvent[]): { seen: number; required: number } | null {
  if (status !== 'created') return null;
  const last = [...events].reverse().find((e) => e.event.startsWith('rail.'));
  if (!last || last.event !== 'rail.pending') return null;
  if ('confirmations' in last && last.confirmations) return last.confirmations;
  const { confirmations: seen, required } = historyPayload(last);
  return Number.isInteger(seen) && Number.isInteger(required) && (seen as number) >= 0 && (required as number) > 0
    ? { seen: seen as number, required: required as number }
    : null;
}

export type PayoutState = 'not_ready' | 'unknown' | 'ready' | 'awaiting_approval' | 'approved' | 'rejected' | 'paid_out' | 'failed';

// ---- approvals (P31) -----------------------------------------------------------------------------------

export type Span = { n: number; unit: 'minutes' | 'hours' | 'days' };

/** A length of time in the largest sensible unit. Under a minute reads as zero minutes, which the copy turns into "just now". */
export function spanParts(ms: number): Span {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return { n: minutes, unit: 'minutes' };
  if (minutes < 60 * 48) return { n: Math.floor(minutes / 60), unit: 'hours' };
  return { n: Math.floor(minutes / 1440), unit: 'days' };
}

export type DecisionBlock = 'status' | 'checked' | 'expired' | 'own' | 'role' | null;

export function usagePct(used: string, limit: string): number {
  const u = parseAmount(used);
  const l = parseAmount(limit);
  if (l === 0n) return 100;
  if (u >= l) return 100;
  return Number((u * 1000n) / l) / 10;
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
