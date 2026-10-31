import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { PayError, assertWithdrawalListLimit } from '../payment-service.js';
import { failureReason } from './reasons.js';
import type { ReturnReasonCode } from './returns/schemas.js';
import { shownFilterFor, shownStatus, WITHDRAWAL_CANCELED_CODE, type DispatchJournal, type WithdrawalStatus } from './status.js';

/**
 * The customer's withdrawal history (W-withdraw-06): one page of their own withdrawals in the customer status
 * vocabulary (a held row split by its current attempt's dispatch journal, as `withdrawal.get` shows it), filtered by asset, status, id and time, paged by a keyset cursor so no page depends on an offset and a
 * history longer than 200 rows can still be read to the end. The caller says the page size; there is no default.
 */
export interface WithdrawalHistoryFilter {
  readonly assetId?: string;
  readonly status?: WithdrawalStatus;
  readonly id?: string;
  /** Inclusive lower bound on `createdAt`. */
  readonly since?: string;
  /** Exclusive upper bound on `createdAt`. */
  readonly until?: string;
  readonly limit?: number;
  readonly after?: string;
}

export interface WithdrawalHistoryItem {
  readonly id: string;
  /** Always the caller: the page is read for one user, and says whose it is so a client can refuse a crossed answer. */
  readonly userId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly rail: string;
  readonly destination: { kind: string; ref: string };
  readonly clientRef: string;
  readonly railRef: string | null;
  readonly attempts: number;
  readonly status: WithdrawalStatus;
  /** Plain words for the failure, or the raw code when it is not one we explain. `null` when nothing failed. */
  readonly failure: { code: string; known: boolean; message: string } | null;
  /** True when the funds of a sent withdrawal came back from the outside. */
  readonly returned: boolean;
  /**
   * What came back, when anything did: the amount, why in words the customer may read (null on a return recorded before
   * the code existed), and whether it is back in available yet. It is only `credited` once the ledger booked it.
   */
  readonly returnedFunds: { amount: string; reasonCode: ReturnReasonCode | null; credited: boolean } | null;
  readonly createdAt: string;
}

export interface WithdrawalHistoryPage {
  readonly items: WithdrawalHistoryItem[];
  /** Pass as `after` for the next page; `null` when there is none. */
  readonly next: string | null;
}

interface Row {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  rail: string;
  destination: { kind: string; ref: string };
  client_ref: string;
  rail_ref: string | null;
  attempts: number;
  failure_code: string | null;
  status: string;
  journal: DispatchJournal;
  returned: boolean;
  returned_amount: string | null;
  returned_reason_code: ReturnReasonCode | null;
  returned_credited: boolean;
  created_at: string;
}

/**
 * A cursor names the last row of the page: its time (microsecond text) and its id. The time goes back to Postgres as
 * text and is cast there: a timestamp parameter would pass through a JS Date and lose the microseconds.
 */
function encodeCursor(row: Pick<Row, 'created_at' | 'id'>): string {
  return Buffer.from(JSON.stringify({ t: row.created_at, i: row.id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { t: string; i: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const { t, i } = parsed as { t?: unknown; i?: unknown };
    if (typeof t === 'string' && typeof i === 'string' && /^[0-9T:.\-Z+ ]{10,40}$/.test(t) && /^[0-9a-f-]{36}$/.test(i)) return { t, i };
  } catch {
    // fall through
  }
  throw new PayError('The page cursor is not one this history issued', 'pay.withdrawal_cursor_invalid');
}

export function createWithdrawalHistory(sql: Sql) {
  return {
    async search(userId: string, filter: WithdrawalHistoryFilter): Promise<WithdrawalHistoryPage> {
      const limit = assertWithdrawalListLimit(filter.limit);
      // A status no stored value can mean yet matches nothing, so the page is empty rather than wrong.
      const shown = filter.status ? shownFilterFor(filter.status) : null;
      const stored = shown?.stored ?? null;
      const journal = shown?.journal ?? null;
      if (stored !== null && stored.length === 0) return { items: [], next: null };
      // `canceled` and `failed` share a stored value; the cancel code tells them apart.
      const canceledOnly = filter.status === 'canceled' ? true : filter.status === 'failed' ? false : null;
      const cursor = filter.after ? decodeCursor(filter.after) : null;
      const rows = await sql<Row[]>`
        SELECT w.id, w.user_id, w.asset_id, w.amount::text AS amount, w.rail, w.destination, w.client_ref, w.rail_ref, w.attempts,
               w.failure_code, w.status::text AS status,
               CASE WHEN a.outcome = 'accepted' AND a.confirmations > 0 THEN 'confirming' ELSE a.outcome END AS journal,
               (wr.withdrawal_id IS NOT NULL) AS returned, wr.amount::text AS returned_amount, wr.reason_code AS returned_reason_code,
               (wp.withdrawal_id IS NOT NULL) AS returned_credited,
               to_char(w.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
          FROM pay.withdrawals w
          LEFT JOIN pay.withdrawal_rail_attempts a ON a.withdrawal_id = w.id AND a.attempt = w.attempts
          LEFT JOIN pay.withdrawal_returns wr ON wr.withdrawal_id = w.id
          LEFT JOIN pay.withdrawal_return_postings wp ON wp.withdrawal_id = w.id
         WHERE w.user_id = ${userId}
           AND (${filter.assetId ?? null}::text IS NULL OR w.asset_id = ${filter.assetId ?? null})
           AND (${stored}::text[] IS NULL OR w.status::text = ANY(${stored}::text[]))
           AND (${journal}::text[] IS NULL OR coalesce(CASE WHEN a.outcome = 'accepted' AND a.confirmations > 0 THEN 'confirming' ELSE a.outcome END, 'none') = ANY(${journal}::text[]))
           AND (${canceledOnly}::boolean IS NULL OR (w.failure_code IS NOT DISTINCT FROM ${WITHDRAWAL_CANCELED_CODE}) = ${canceledOnly})
           AND (${filter.id ?? null}::uuid IS NULL OR w.id = ${filter.id ?? null})
           AND (${filter.since ?? null}::text IS NULL OR w.created_at >= ${filter.since ?? null}::text::timestamptz)
           AND (${filter.until ?? null}::text IS NULL OR w.created_at < ${filter.until ?? null}::text::timestamptz)
           AND (${cursor?.t ?? null}::text IS NULL OR (w.created_at, w.id) < (${cursor?.t ?? null}::text::timestamptz, ${cursor?.i ?? null}::uuid))
         ORDER BY w.created_at DESC, w.id DESC
         LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      const items = page.map((r): WithdrawalHistoryItem => {
        const status = shownStatus(r.status, r.failure_code, r.journal);
        // Only a failed row has had its hold reversed; a held or pending row with a code must not claim funds came back.
        const reason = status === 'failed' ? failureReason(r.failure_code) : null;
        return {
          id: r.id,
          userId: r.user_id,
          assetId: r.asset_id,
          amount: r.amount,
          rail: r.rail,
          destination: r.destination,
          clientRef: r.client_ref,
          railRef: r.rail_ref,
          attempts: r.attempts,
          status,
          failure: reason ? { code: reason.code, known: reason.known, message: reason.customer } : null,
          returned: r.returned,
          returnedFunds:
            r.returned && r.returned_amount !== null
              ? { amount: formatAmount(parseAmount(r.returned_amount)), reasonCode: r.returned_reason_code, credited: r.returned_credited }
              : null,
          createdAt: r.created_at,
        };
      });
      const last = page[page.length - 1];
      return { items, next: rows.length > limit && last ? encodeCursor(last) : null };
    },
  };
}
export type WithdrawalHistory = ReturnType<typeof createWithdrawalHistory>;
