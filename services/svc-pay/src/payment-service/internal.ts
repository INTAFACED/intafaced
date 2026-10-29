/**
 * Module-level helpers of `PayService` that the class file and its area files share: the payment and
 * settlement row readers and writers, the state machine, list limits and the `PayError` type.
 *
 * Moved out of `payment-service.ts` as they were (owner decision 2026-10-23). Only `payment-service.ts` and
 * the files in this folder import this module; `payment-service.ts` re-exports the names it exported before.
 * It imports no value from `payment-service.ts`, so loading any area file first cannot hit a half-loaded class file.
 */

import { MerchantStoredFeeError, normalizeStoredFeeBps } from '../starter-fee.js';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, InsufficientFundsError, LedgerError, parseAmount, recipes, type Amount } from '@intafaced/ledger-client';
import { railBlockingReason, railReasonCode, type PaymentIntent, type RailAdapter, type RailResult } from '../rails/rail-adapter.js';
import { type SettlementLedgerPlan } from '../settlement-ledger.js';
import { ListQueryError, parseListFilters, type ListFilters } from '../list-page.js';
import { MAX_FEE_BPS } from '../fee-bps-bound.js';
import type {
  PayErrorCode,
  PaymentStatus,
  PayService,
  PaymentRow,
  ChargebackPlan,
  MerchantRecord,
  KybActor,
  MerchantRow,
  PaymentRecord,
  SettlementRow,
  SettlementRecord,
} from '../payment-service.js';

export class PayError extends Error {
  constructor(
    message: string,
    readonly code: PayErrorCode,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PayError';
  }
}

/** Stale, probe-failed, or marked-down. Throws before a hold or a rail send. Absent rails are not this case. */
export function refuseUnusableRail(adapter: RailAdapter, now: Date): void {
  const reason = railBlockingReason(adapter, now);
  if (!reason) return;
  throw new PayError(`Rail "${adapter.id}" is not usable (${reason}). No value moved.`, 'pay.rail_failed', {
    failureCode: railReasonCode(reason),
  });
}

/** Owner house take unpublished. Blank PAY_DEFAULT_FEE_BPS is not 0. */
export function publishedDefaultFeeBps(feeBps: number | null | undefined): number {
  if (feeBps == null) {
    throw new PayError('PAY_DEFAULT_FEE_BPS is unset — refusing rather than settling at 0 bps', 'pay.fee_bps_unset');
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new PayError(`Fee must be an integer between 0 and ${MAX_FEE_BPS} bps, got ${feeBps}`, 'pay.merchant_pricing_invalid');
  }
  return feeBps;
}

export function assertOwnerPageLimit(limit: number | undefined, code: PayErrorCode, cap: number, message: string): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new PayError(message, code);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new PayError(message, code);
  }
  return Math.min(cap, n);
}

/** payment.list page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertPaymentListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.payment_list_limit_unset',
    200,
    'payment.list page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

/** payment.history page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertPaymentHistoryLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.payment_history_limit_unset',
    200,
    'payment.history page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

/** settlement.list page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertSettlementListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.settlement_list_limit_unset',
    200,
    'settlement.list page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

export function listFilters(input: { search?: string; assetId?: string; from?: string; to?: string; cursor?: string }): ListFilters {
  try {
    return parseListFilters(input);
  } catch (err) {
    if (err instanceof ListQueryError) throw new PayError(err.message, err.code);
    throw err;
  }
}

/** Which statuses may legally follow which. Anything else is a bug, not an edge case. */
export const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  created: ['authorized', 'failed'],
  authorized: ['captured', 'failed'],
  captured: ['settled', 'refunded', 'disputed'],
  settled: ['refunded', 'disputed'],
  refunded: [],
  // A won dispute returns the money, so the payment goes back to where it came from (see restoreAfterWonDispute).
  disputed: ['captured', 'settled'],
  failed: [],
};

/** Hold keys for one payout attempt. The legacy key is a pre-cutover user hold. */
export function payoutHoldKeys(settlementId: string, attempt: number): { legacy: string; proceeds: string } {
  const withdrawalId = `${settlementId}:${attempt}`;
  return {
    legacy: `withdraw.hold:${withdrawalId}`,
    proceeds: `pay.proceeds.payout.hold:${withdrawalId}`,
  };
}

/**
 * A hold booked before proceeds existed debited `userAvailable` into a user
 * withdrawal hold. Finishing it uses that trio. A new attempt uses proceeds.
 * Posting the proceeds trio on top of the legacy hold would pay twice.
 */
export function legacyUserPayoutPlan(
  userId: string,
  assetId: string,
  amount: Amount,
  railId: string,
  withdrawalId: string,
  destinationKind: SettlementLedgerPlan['destinationKind'],
): SettlementLedgerPlan {
  const withdrawal = { userId, assetId, amount, rail: railId, withdrawalId };
  return {
    withdrawalId,
    destinationKind,
    hold: recipes.withdrawHold(withdrawal),
    settle: recipes.withdrawSettle(withdrawal),
    reverse: recipes.withdrawReverse(withdrawal),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Write a payment row and its `created` event.
 *
 * Extracted so `createPayment` (a merchant integration naming its own rail) and
 * `openCheckoutSession` (an anonymous payer on a rail the server chose) produce
 * BYTE-IDENTICAL rows and event payloads. Two code paths writing a payments row
 * two slightly different ways is how one of them ends up missing a field the
 * settlement sweep or a dispute later depends on.
 */
export function paymentCreationPayload(input: Parameters<PayService['createPayment']>[0], paymentId: string): Record<string, unknown> {
  return {
    paymentId,
    merchantId: input.merchantId.toLowerCase(),
    profileId: input.profileId?.toLowerCase() ?? null,
    amount: formatAmount(input.amount),
    assetId: input.assetId,
    method: input.method,
    railAdapter: input.railAdapter,
    instrument: input.instrument ?? null,
    customerRef: input.customerRef ?? null,
    metadata: input.metadata ?? {},
    ...(input.keyEnv === 'sandbox' ? { sandbox: true } : {}),
  };
}

export async function insertPayment(
  tx: Sql,
  input: {
    id?: string;
    merchantId: string;
    profileId?: string | null;
    amount: Amount;
    assetId: string;
    method: string;
    railAdapter: string;
    instrument?: PaymentIntent['instrument'];
    customerRef?: string;
    metadata?: Record<string, string>;
    /** Immutable. Written only when the creating key was sandbox. */
    sandbox?: boolean;
  },
): Promise<PaymentRow> {
  const rows = await tx<PaymentRow[]>`
    INSERT INTO pay.payments (id, merchant_id, profile_id, amount, currency, method, rail_adapter, status)
    VALUES (
      ${input.id ?? randomUUID()}, ${input.merchantId}, ${input.profileId ?? null}, ${formatAmount(input.amount)}::numeric,
      ${input.assetId}, ${input.method}, ${input.railAdapter}, 'created'
    )
    RETURNING id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
  `;
  const row = rows[0]!;

  await appendEvent(tx, row.id, 'created', {
    amount: formatAmount(input.amount),
    assetId: input.assetId,
    method: input.method,
    railAdapter: input.railAdapter,
    customerRef: input.customerRef ?? null,
    // The instrument lives on the `created` event rather than in a column
    // because it is a rail's business, not ours, and because a tokenised
    // instrument is the sort of thing that must never end up in a WHERE clause
    // by accident.
    instrument: input.instrument ?? null,
    metadata: input.metadata ?? {},
    ...(input.sandbox ? { sandbox: true } : {}),
  });

  return row;
}

/**
 * Mark a hosted-checkout session paid, and count the use against its link.
 *
 * Runs inside the capture transaction. Two properties are load-bearing:
 *
 *   IT IS IDEMPOTENT — the UPDATE only matches a session that is not already
 *   `completed` — so a redelivered webhook that re-runs capture does not count a
 *   second use against the link.
 *
 *   IT PROMOTES AN `expired` SESSION TO `completed`. A payer whose tab timed out
 *   and who then sent the funds anyway HAS PAID, and the session is the record of
 *   that payer's attempt. Leaving it `expired` next to a captured payment would
 *   be the books and the checkout disagreeing about the same money.
 *
 *   IT NEVER REFUSES. The link's `uses` is incremented UNCONDITIONALLY, even
 *   past `max_uses`. That is not sloppiness about the bound, it is the same rule
 *   that governs a deposit: money that has ALREADY ARRIVED must always be
 *   bookable. The bound is a gate on opening a checkout, where nothing has
 *   moved; enforcing it here would mean refusing to record value sitting at an
 *   address we control, and stranding it is a far worse outcome than a merchant
 *   taking one payment past their own ceiling.
 *
 * Which makes the bound honestly ADVISORY under concurrency: two payers who
 * open sessions at the same instant on a `maxUses: 1` link can both pay, and
 * both are booked. `payment_links.uses` then reads 2 and the next open is
 * refused. The service says so rather than implying a hard cap it cannot keep.
 */
export async function completeCheckoutSession(tx: Sql, paymentId: string): Promise<void> {
  const closed = await tx<Array<{ link_id: string }>>`
    UPDATE pay.checkout_sessions
       SET status = 'completed', updated_at = now()
     WHERE payment_id = ${paymentId} AND status IN ('open', 'expired')
     RETURNING link_id
  `;
  for (const { link_id } of closed) {
    await tx`UPDATE pay.payment_links SET uses = uses + 1 WHERE id = ${link_id}`;
  }
}

export async function readPayment(tx: Sql, paymentId: string): Promise<PaymentRow> {
  const rows = await tx<PaymentRow[]>`
    SELECT id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
      FROM pay.payments WHERE id = ${paymentId}
  `;
  const row = rows[0];
  if (!row) throw new PayError(`Payment ${paymentId} not found`, 'pay.payment_not_found');
  return row;
}

export async function lockPayment(tx: Sql, paymentId: string): Promise<PaymentRow> {
  const rows = await tx<PaymentRow[]>`
    SELECT id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
      FROM pay.payments WHERE id = ${paymentId} FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new PayError(`Payment ${paymentId} not found`, 'pay.payment_not_found');
  return row;
}

export function assertTransition(row: PaymentRow, next: PaymentStatus): void {
  if (!TRANSITIONS[row.status].includes(next)) {
    throw new PayError(`Payment ${row.id} cannot go from ${row.status} to ${next}`, 'pay.invalid_transition', {
      from: row.status,
      to: next,
    });
  }
}

/**
 * Captured and refunded totals, summed from the append-only log.
 *
 * Deliberately not columns. A running total on the payment row would be a
 * second source of truth for money, and the day it disagrees with the event log
 * is the day nobody can say which one was right.
 */
export function readIncludedAmount(raw: string | null): { amount: Amount | null; includedAmountKnown: boolean } {
  if (raw == null || raw.trim() === '') return { amount: null, includedAmountKnown: false };
  try {
    return { amount: parseAmount(raw), includedAmountKnown: true };
  } catch {
    return { amount: null, includedAmountKnown: false };
  }
}

export async function totalsFor(sql: Sql, paymentId: string): Promise<{ captured: Amount; refunded: Amount }> {
  const rows = await sql<Array<{ captured: string; refunded: string }>>`
    SELECT
      COALESCE(SUM(CASE WHEN event = 'captured' THEN (payload->>'amount')::numeric END), 0) AS captured,
      COALESCE(SUM(CASE WHEN event = 'refunded' THEN (payload->>'amount')::numeric END), 0) AS refunded
      FROM pay.payment_events WHERE payment_id = ${paymentId}
  `;
  const row = rows[0];
  return { captured: parseAmount(row?.captured ?? '0'), refunded: parseAmount(row?.refunded ?? '0') };
}

export async function countEvents(sql: Sql, paymentId: string, event: string): Promise<number> {
  const rows = await sql<Array<{ n: string }>>`
    SELECT COUNT(*)::text AS n FROM pay.payment_events WHERE payment_id = ${paymentId} AND event = ${event}
  `;
  return Number.parseInt(rows[0]?.n ?? '0', 10);
}

/** The ledger refused for want of funds: the HTTP client rebuilds the subclass, but any LedgerError carrying the code counts. */
export function isInsufficientFunds(e: unknown): boolean {
  return e instanceof InsufficientFundsError || (e instanceof LedgerError && e.code === 'ledger.insufficient_funds');
}

export function postgresErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function openingTxIdFromDetail(detail: Record<string, unknown> | undefined): string | null {
  const id = detail?.openingTxId;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

/**
 * The dispute's live opening plan: the latest `chargeback.opening_planned` that no later `chargeback.opening_plan_voided`
 * retired. A void applies to the plans before it; a plan made after a void is live.
 */
export async function readLivePlan(sql: Sql, paymentId: string, disputeId: string): Promise<ChargebackPlan | null> {
  const rows = await sql<Array<{ seq: string; event: string; payload: Omit<ChargebackPlan, 'seq'> }>>`
    SELECT seq, event, payload FROM pay.payment_events
     WHERE payment_id = ${paymentId}
       AND event IN ('chargeback.opening_planned', 'chargeback.opening_plan_voided')
       AND payload->>'disputeId' = ${disputeId}
     ORDER BY seq ASC
  `;
  let live: ChargebackPlan | null = null;
  for (const row of rows) {
    live = row.event === 'chargeback.opening_planned' ? { ...row.payload, seq: String(row.seq) } : null;
  }
  return live;
}

export async function appendEvent(sql: Sql, paymentId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  await sql`
    INSERT INTO pay.payment_events (payment_id, event, payload)
    VALUES (${paymentId}, ${event}, ${sql.json(payload as never)})
  `;
}

/** The instrument the payment was created with, read back off the `created` event. */
export async function instrumentFor(sql: Sql, paymentId: string): Promise<PaymentIntent['instrument']> {
  const rows = await sql<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload FROM pay.payment_events WHERE payment_id = ${paymentId} AND event = 'created' LIMIT 1
  `;
  const instrument = rows[0]?.payload?.instrument;
  if (typeof instrument !== 'object' || instrument === null) return undefined;
  const i = instrument as Record<string, unknown>;
  if (typeof i.kind !== 'string') return undefined;
  return {
    kind: i.kind,
    token: typeof i.token === 'string' ? i.token : undefined,
    address: typeof i.address === 'string' ? i.address : undefined,
  };
}

/**
 * How deep a pending crypto result's furthest-behind transfer is and how deep it must be (J-merchant-05 #4), from a rail
 * result's `raw` or a stored `rail.pending` payload (same keys). Null unless both are whole numbers in range.
 */
export function confirmationDepth(source: Record<string, unknown> | null | undefined): { seen: number; required: number } | null {
  const seen = source?.confirmations;
  const required = source?.required;
  return Number.isInteger(seen) && Number.isInteger(required) && (seen as number) >= 0 && (required as number) > 0
    ? { seen: seen as number, required: required as number }
    : null;
}

function waitingDepth(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const depth = confirmationDepth(raw);
  return depth ? { confirmations: depth.seen, required: depth.required } : {};
}

export function railPayload(result: RailResult): Record<string, unknown> {
  return {
    ok: result.ok,
    status: result.status,
    railRef: result.railRef,
    // Decimal string. A bigint does not survive JSON and a number does not
    // survive 18 decimal places.
    amount: formatAmount(result.amount),
    assetId: result.assetId,
    at: result.at.toISOString(),
    failureCode: result.failureCode ?? null,
    failureReason: result.failureReason ?? null,
    // A payment paid in parts: what has arrived, what is still missing and what is on its way, as the rail counted it.
    ...(typeof result.raw?.received === 'string' && typeof result.raw?.missing === 'string'
      ? {
          received: result.raw.received,
          missing: result.raw.missing,
          ...(typeof result.raw.confirming === 'string' ? { confirming: result.raw.confirming } : {}),
        }
      : {}),
    // Waiting for confirmations (J-merchant-05 #4), kept only on a pending result: the count the merchant reads while it waits.
    ...(result.status === 'pending' ? waitingDepth(result.raw) : {}),
  };
}

/** One `merchant_kyb_events` row, written inside the transaction that moved `kyb_status`. */
export async function recordKybEvent(
  tx: Sql,
  e: {
    merchantId: string;
    from: MerchantRecord['kybStatus'];
    to: MerchantRecord['kybStatus'];
    kybRef: string | null;
    reason: string;
    actor: KybActor;
  },
): Promise<void> {
  await tx`
    INSERT INTO pay.merchant_kyb_events (merchant_id, from_status, to_status, kyb_ref, reason, actor_id, actor_scope)
    VALUES (${e.merchantId}, ${e.from}::pay.kyb_status, ${e.to}::pay.kyb_status, ${e.kybRef}, ${e.reason}, ${e.actor.id}, ${e.actor.scope})`;
}

export const kybDecisionReason = (decision: 'approved' | 'rejected') =>
  decision === 'approved' ? 'Verification approved' : 'Verification rejected';

export function toMerchant(row: MerchantRow): MerchantRecord {
  let feeBps: number | null;
  try {
    feeBps = normalizeStoredFeeBps(row.pricing);
  } catch (err) {
    if (err instanceof MerchantStoredFeeError) {
      throw new PayError(`Merchant ${row.id} has malformed pricing`, 'pay.merchant_pricing_invalid', { pricing: row.pricing });
    }
    throw err;
  }
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode,
    tier: Number(row.tier),
    kybStatus: row.kyb_status,
    kybRef: row.kyb_ref ?? null,
    status: row.status,
    pricing: { feeBps: feeBps ?? undefined },
    settlementPrefs: row.settlement_prefs ?? {},
  };
}

export function toPayment(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    profileId: row.profile_id,
    amount: parseAmount(row.amount),
    assetId: row.currency,
    method: row.method,
    railAdapter: row.rail_adapter,
    railRef: row.rail_ref,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function toSettlement(row: SettlementRow): SettlementRecord {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    window: row.window,
    assetId: row.asset_id,
    gross: parseAmount(row.gross),
    fees: parseAmount(row.fees),
    net: parseAmount(row.net),
    payoutMethod: row.payout_method,
    payoutRef: row.payout_ref,
    payoutAttempts: Number(row.payout_attempts),
    status: row.status,
  };
}

export function assertFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new PayError(`Fee must be an integer between 0 and ${MAX_FEE_BPS} bps, got ${feeBps}`, 'pay.merchant_pricing_invalid');
  }
}

/**
 * `'2026-07-27'` → that UTC day, half-open, ending 24 hours later.
 * A year 0000–0099 label is that written year. Both explicit bounds win.
 * Exactly one bound refuses. A label that matches YYYY-MM-DD but is not a
 * real UTC calendar day (2026-02-31) refuses — it is not rolled through Date
 * and not frozen under the original window key.
 */
export function windowBounds(window: string, from?: Date, to?: Date): { from: Date; to: Date } {
  if (from && to) return { from, to };
  if (from || to) {
    throw new PayError(`Window "${window}" was given only one of from/to; pass both bounds or neither`, 'pay.invalid_window');
  }
  const day = utcCalendarDay(window);
  if (!day) {
    throw new PayError(
      `Window "${window}" is not a YYYY-MM-DD date; pass explicit from/to bounds for a custom window`,
      'pay.invalid_window',
    );
  }
  return { from: day, to: new Date(day.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * UTC midnight of a real calendar day, or null.
 * Impossible dates are rejected from the year/month/day fields. The instant is
 * then `YYYY-MM-DDT00:00:00.000Z`, which keeps years 0000–0099. Date.UTC maps
 * years 0–99 onto 1900–1999, so it is the wrong construction here. The result
 * is checked so a rollover cannot be returned.
 */
export function utcCalendarDay(window: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(window);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInUtcMonth(year, month)) return null;
  const start = new Date(`${window}T00:00:00.000Z`);
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) return null;
  return start;
}

export function daysInUtcMonth(year: number, month: number): number {
  if (month === 2) return isUtcLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

export function isUtcLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
