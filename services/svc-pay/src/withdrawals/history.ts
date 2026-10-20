import type { Sql } from 'postgres';
import { PayError, assertWithdrawalListLimit } from '../payment-service.js';
import { failureReason } from './reasons.js';
import { customerStatus, storedStatusesFor, type WithdrawalStatus } from './status.js';

/**
 * The customer's withdrawal history (W-withdraw-06): one page of their own withdrawals in the customer status
 * vocabulary, filtered by asset, status, id and time, paged by a keyset cursor so no page depends on an offset and a
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
  readonly createdAt: string;
}

export interface WithdrawalHistoryPage {
  readonly items: WithdrawalHistoryItem[];
  /** Pass as `after` for the next page; `null` when there is none. */
  readonly next: string | null;
}

interface Row {
  id: string;
  asset_id: string;
  amount: string;
  rail: string;
  destination: { kind: string; ref: string };
  client_ref: string;
  rail_ref: string | null;
  attempts: number;
  failure_code: string | null;
  status: string;
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
      const stored = filter.status ? storedStatusesFor(filter.status) : null;
      if (stored !== null && stored.length === 0) return { items: [], next: null };
      const cursor = filter.after ? decodeCursor(filter.after) : null;
      const rows = await sql<Row[]>`
        SELECT id, asset_id, amount::text AS amount, rail, destination, client_ref, rail_ref, attempts, failure_code,
               status::text AS status, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
          FROM pay.withdrawals
         WHERE user_id = ${userId}
           AND (${filter.assetId ?? null}::text IS NULL OR asset_id = ${filter.assetId ?? null})
           AND (${stored}::text[] IS NULL OR status::text = ANY(${stored}::text[]))
           AND (${filter.id ?? null}::uuid IS NULL OR id = ${filter.id ?? null})
           AND (${filter.since ?? null}::text IS NULL OR created_at >= ${filter.since ?? null}::text::timestamptz)
           AND (${filter.until ?? null}::text IS NULL OR created_at < ${filter.until ?? null}::text::timestamptz)
           AND (${cursor?.t ?? null}::text IS NULL OR (created_at, id) < (${cursor?.t ?? null}::text::timestamptz, ${cursor?.i ?? null}::uuid))
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      const items = page.map((r): WithdrawalHistoryItem => {
        // Only a failed row has had its hold reversed; a held or pending row with a code must not claim funds came back.
        const reason = r.status === 'failed' ? failureReason(r.failure_code) : null;
        return {
          id: r.id,
          assetId: r.asset_id,
          amount: r.amount,
          rail: r.rail,
          destination: r.destination,
          clientRef: r.client_ref,
          railRef: r.rail_ref,
          attempts: r.attempts,
          status: customerStatus(r.status),
          failure: reason ? { code: reason.code, known: reason.known, message: reason.customer } : null,
          createdAt: r.created_at,
        };
      });
      const last = page[page.length - 1];
      return { items, next: rows.length > limit && last ? encodeCursor(last) : null };
    },
  };
}
export type WithdrawalHistory = ReturnType<typeof createWithdrawalHistory>;
