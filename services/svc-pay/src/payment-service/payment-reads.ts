/**
 * Payment reads: lists, attempts, facts, one payment, its history and the merchant balances.
 *
 * Moved out of `payment-service.ts` as it was (owner decision 2026-10-23): `PayService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { merchantClearing, merchantProceeds, type Amount } from '@intafaced/ledger-client';
import { encodeListCursor } from '../list-page.js';
import { attemptFromRailAuthorize, type PaymentAttemptView } from '../payments/attempts.js';
import { boundAmount } from '../payments/amounts.js';
import { paymentListSummaryFromText, type PaymentListSummary } from '../payments/list-summary.js';
import { safeFailure, type MerchantFailure } from '../merchant-failure.js';
import { readPricingSnapshots, type StoredPricingSnapshot } from '../control/snapshots.js';
import type {
  PayService,
  PayServiceInternal,
  PaymentEventRecord,
  PaymentPage,
  PaymentRead,
  PaymentRow,
  PaymentStatus,
  PaymentView,
} from '../payment-service.js';
import { PayError, assertPaymentHistoryLimit, assertPaymentListLimit, confirmationDepth, listFilters } from './internal.js';

/**
 * Merchant payment list — durable status projection for the acquiring surface.
 * Status is whatever `payments.status` currently projects from `payment_events`.
 *
 * Pages are keyset-ordered by `(created_at, id)` descending. Search matches the
 * payment id, the rail reference, the customer reference, or the merchant
 * reference (`metadata.reference` on the created event). It does not match a
 * name, an email, or any other metadata key. The fee snapshot and failure
 * are the stored rows, or null.
 *
 * `summary` counts every row of the filter, not this page. `linkId` keeps
 * payments whose checkout session names that link. The seek uses
 * `checkout_sessions_link_status_idx` (`link_id`, `status`). A link that is
 * missing or belongs to another merchant matches no session of this merchant,
 * so the page is empty. That is not an error.
 */
export async function listPayments(
  svc: PayServiceInternal,
  input: {
    merchantId: string;
    status?: PaymentStatus;
    limit?: number;
    cursor?: string;
    search?: string;
    assetId?: string;
    from?: string;
    to?: string;
    linkId?: string;
    amountMin?: string;
    amountMax?: string;
    /**
     * Sandbox keys pass `sandbox` so the page and its cursor are chosen from
     * sandbox rails only. Filtering after the page would let `nextCursor`
     * name a live payment the caller must not see.
     */
    railMode?: 'sandbox';
  },
): Promise<PaymentPage> {
  await svc.getMerchant(input.merchantId);
  const limit = assertPaymentListLimit(input.limit);
  const filters = listFilters(input);
  svc.assertListStatus(input.status, ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']);
  const min = boundAmount(input.amountMin);
  const max = boundAmount(input.amountMax);
  if (min.kind === 'invalid' || max.kind === 'invalid') {
    throw new PayError('Payment amount filter is blank or not a decimal string', 'pay.list_amount_invalid');
  }
  if (min.kind === 'amount' && max.kind === 'amount' && min.scaled > max.scaled) {
    throw new PayError('Payment amount filter starts above its end', 'pay.list_amount_range_invalid');
  }
  const amountMin = min.kind === 'amount' ? min.canonical : '0';
  const amountMax = max.kind === 'amount' ? max.canonical : '0';
  const hasMin = min.kind === 'amount';
  const hasMax = max.kind === 'amount';
  const cursorAt = filters.cursor?.createdAtCursor ?? null;
  const cursorId = filters.cursor?.id ?? null;
  const sandboxOnly = input.railMode === 'sandbox';
  const linkId = input.linkId ?? null;
  const linkFilter =
    linkId === null
      ? svc.sql``
      : svc.sql`AND p.id IN (
           SELECT s.payment_id
             FROM pay.checkout_sessions s
            WHERE s.link_id = ${linkId}
              AND s.merchant_id = ${input.merchantId}
              AND s.payment_id IS NOT NULL
         )`;
  const match = svc.sql`
    p.merchant_id = ${input.merchantId}
    ${linkFilter}
    AND (${sandboxOnly}::boolean = false OR right(p.rail_adapter, 8) = '-sandbox')
    AND (${input.status ?? null}::text IS NULL OR p.status::text = ${input.status ?? null})
    AND (${filters.assetId}::text IS NULL OR p.currency = ${filters.assetId})
    AND (${filters.from}::timestamptz IS NULL OR p.created_at >= ${filters.from})
    AND (${filters.to}::timestamptz IS NULL OR p.created_at < ${filters.to})
    AND (${hasMin}::boolean = false OR p.amount >= ${amountMin}::numeric)
    AND (${hasMax}::boolean = false OR p.amount <= ${amountMax}::numeric)
    AND (
      ${filters.search}::text IS NULL
      OR p.id::text = lower(${filters.search})
      OR p.rail_ref = ${filters.search}
      OR EXISTS (
        SELECT 1 FROM pay.payment_events e
         WHERE e.payment_id = p.id
           AND e.event = 'created'
           AND (
             e.payload->>'customerRef' = ${filters.search}
             OR e.payload->'metadata'->>'reference' = ${filters.search}
           )
      )
    )
  `;
  const rows = await svc.sql<Array<PaymentRow & { created_at_cursor: string }>>`
    SELECT p.id, p.merchant_id, p.profile_id, p.amount::text, p.currency, p.method, p.rail_adapter, p.rail_ref, p.status, p.created_at,
           to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
      FROM pay.payments p
     WHERE ${match}
       AND (
         ${cursorAt}::timestamptz IS NULL
         OR (p.created_at, p.id) < (${cursorAt}::timestamptz, ${cursorId}::uuid)
       )
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT ${limit + 1}
  `;
  const [totals] = await svc.sql<Array<{ matched: string; succeeded: string; failed: string }>>`
    SELECT count(*)::text AS matched,
           count(*) FILTER (WHERE p.status::text IN ('captured', 'settled', 'refunded', 'disputed'))::text AS succeeded,
           count(*) FILTER (WHERE p.status::text = 'failed')::text AS failed
      FROM pay.payments p
     WHERE ${match}
  `;
  let summary: PaymentListSummary;
  try {
    summary = paymentListSummaryFromText(totals?.matched ?? '', totals?.succeeded ?? '', totals?.failed ?? '');
  } catch {
    throw new PayError('Payment list totals could not be read', 'pay.list_summary_unreadable');
  }
  const pageRows = rows.slice(0, limit);
  const items: PaymentRead[] = [];
  const views: PaymentView[] = [];
  for (const row of pageRows) views.push(await svc.view(svc.sql, row));
  const facts = await svc.paymentFactsFor(views.map((v) => v.id));
  for (const view of views) {
    const fact = facts.get(view.id);
    items.push({ ...view, pricingSnapshot: fact?.pricingSnapshot ?? null, failure: fact?.failure ?? null });
  }
  const last = pageRows[pageRows.length - 1];
  const nextCursor = rows.length > limit && last ? encodeListCursor(last.created_at_cursor, last.id) : null;
  return { items, nextCursor, summary };
}

/**
 * Rail tries for one payment, oldest first. Each `rail.authorize` event is
 * one try. An event that is not a readable rail result is left out, not
 * invented. A payment that has not been sent to a rail has an empty list.
 * The caller has already checked ownership.
 */
export async function listPaymentAttempts(svc: PayServiceInternal, paymentId: string): Promise<PaymentAttemptView[]> {
  const rows = await svc.sql<Array<{ id: string; payload: unknown; ts: Date }>>`
    SELECT id, payload, ts
      FROM pay.payment_events
     WHERE payment_id = ${paymentId} AND event = 'rail.authorize'
     ORDER BY seq ASC
  `;
  const attempts: PaymentAttemptView[] = [];
  for (const row of rows) {
    const attempt = attemptFromRailAuthorize(row);
    if (attempt) attempts.push(attempt);
  }
  return attempts;
}

/**
 * While a crypto payment waits for its transfers to be final: the depth from its newest pending rail result, and when
 * that result was recorded (J-merchant-05 #4). Null when no pending result carried a count, or once the payment is no
 * longer `created`.
 */
export async function paymentConfirmations(
  svc: PayServiceInternal,
  paymentId: string,
): Promise<{ seen: number; required: number; asOf: string } | null> {
  const [row] = await svc.sql<Array<{ payload: Record<string, unknown> | null; ts: Date }>>`
    SELECT e.payload, e.ts
      FROM pay.payment_events e
      JOIN pay.payments p ON p.id = e.payment_id
     WHERE e.payment_id = ${paymentId} AND e.event = 'rail.pending'
       -- Only while the payment still waits: once it is authorized, captured or failed, a count would read as waiting.
       AND p.status = 'created'
     ORDER BY e.seq DESC
     LIMIT 1
  `;
  const depth = row ? confirmationDepth(row.payload) : null;
  return depth && row ? { ...depth, asOf: row.ts.toISOString() } : null;
}

/** Stored snapshot and safe failure for one payment. Null when nothing was recorded. */
export async function paymentFacts(
  svc: PayServiceInternal,
  paymentId: string,
): Promise<{ pricingSnapshot: StoredPricingSnapshot | null; failure: MerchantFailure | null }> {
  const facts = await svc.paymentFactsFor([paymentId]);
  return facts.get(paymentId) ?? { pricingSnapshot: null, failure: null };
}

export async function paymentFactsFor(
  svc: PayServiceInternal,
  ids: string[],
): Promise<Map<string, { pricingSnapshot: StoredPricingSnapshot | null; failure: MerchantFailure | null }>> {
  const out = new Map<string, { pricingSnapshot: StoredPricingSnapshot | null; failure: MerchantFailure | null }>();
  if (ids.length === 0) return out;
  const [snapshots, failures] = await Promise.all([
    readPricingSnapshots(svc.sql, 'payment', ids),
    svc.sql<Array<{ payment_id: string; payload: Record<string, unknown> }>>`
      SELECT DISTINCT ON (payment_id) payment_id, payload
        FROM pay.payment_events
       WHERE payment_id = ANY(${svc.sql.array(ids)}::uuid[]) AND event = 'failed'
       ORDER BY payment_id, seq DESC
    `,
  ]);
  const failureById = new Map<string, MerchantFailure>();
  for (const row of failures) {
    const code = typeof row.payload?.failureCode === 'string' ? row.payload.failureCode : null;
    const failure = safeFailure(code);
    if (failure) failureById.set(row.payment_id, failure);
  }
  for (const id of ids) {
    out.set(id, { pricingSnapshot: snapshots.get(id) ?? null, failure: failureById.get(id) ?? null });
  }
  return out;
}

export function assertListStatus(svc: PayServiceInternal, status: string | undefined, allowed: readonly string[]): void {
  if (status !== undefined && !allowed.includes(status)) {
    throw new PayError('List status filter is not a known status', 'pay.validation_failed');
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────
export async function getPayment(svc: PayServiceInternal, paymentId: string): Promise<PaymentView> {
  const rows = await svc.sql<PaymentRow[]>`
    SELECT id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
      FROM pay.payments WHERE id = ${paymentId}
  `;
  const row = rows[0];
  if (!row) throw new PayError(`Payment ${paymentId} not found`, 'pay.payment_not_found');
  return svc.view(svc.sql, row);
}

/** The append-only state history for one payment, oldest first (§6.1). Page size is owner-published — omit is not 50. */
export async function history(svc: PayServiceInternal, paymentId: string, requestedLimit?: number): Promise<PaymentEventRecord[]> {
  const limit = assertPaymentHistoryLimit(requestedLimit);
  const rows = await svc.sql<
    Array<{ id: string; event: string; payload: Record<string, unknown>; rail_event_id: string | null; ts: Date }>
  >`
    SELECT id, event, payload, rail_event_id, ts
      FROM pay.payment_events WHERE payment_id = ${paymentId} ORDER BY seq ASC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({ id: r.id, event: r.event, payload: r.payload, railEventId: r.rail_event_id, ts: r.ts }));
}

/**
 * What svc-pay currently owes a merchant but has not settled.
 *
 * Read from the LEDGER, not from these tables. Doctrine §0.6 means the
 * clearing account is the answer, and asking the ledger keeps the two
 * independent — which is the entire property a reconciliation job needs.
 */
export async function clearingBalance(svc: PayServiceInternal, merchantId: string, assetId: string): Promise<Amount> {
  return (await svc.ledger.balance(merchantClearing(merchantId, assetId))).amount;
}

/**
 * Settled net this merchant can pay out: `merchantProceeds(merchantId)`.
 *
 * Not the owner's trading balance. That stays `userAvailable`. Windows
 * settled before this account existed credited the personal balance, and a
 * replay of that key does not move the money. Summing proceeds under-counts
 * that history; the shortfall is still on the personal account.
 */
export async function merchantBalance(svc: PayServiceInternal, merchantId: string, assetId: string): Promise<Amount> {
  await svc.getMerchant(merchantId);
  return (await svc.ledger.balance(merchantProceeds(merchantId, assetId))).amount;
}
