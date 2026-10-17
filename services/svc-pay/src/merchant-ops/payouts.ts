import type { Sql } from 'postgres';
import { maskDestination } from '../control/mask-destination.js';
import { MerchantOpsError } from './errors.js';
import { iso, money } from './money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * Payout list. A payout is a settlement row: the same table `settlement.list`
 * reads, filtered in SQL (status, asset, dates, id) before the page is cut.
 * `payout_ref` is masked when it is a 20-byte account address. A longer rail
 * transaction reference is returned as stored.
 */

const STATUSES = ['pending', 'posted', 'paid_out', 'failed'] as const;
export type PayoutListStatus = (typeof STATUSES)[number];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function payoutReference(value: string | null): string | null {
  if (!value) return null;
  const compact = value.trim();
  if (ADDRESS.test(compact)) return maskDestination('crypto', compact);
  return compact;
}

interface PayoutRow {
  id: string;
  window: string;
  asset_id: string;
  gross: string;
  fees: string;
  net: string;
  status: PayoutListStatus;
  payout_method: string | null;
  payout_ref: string | null;
  created_at: Date;
  cursor_ts: string;
}

export class PayoutList {
  constructor(private readonly sql: Sql) {}

  async list(
    caller: MerchantCaller,
    input: {
      limit?: number | undefined;
      cursor?: string;
      status?: PayoutListStatus;
      assetId?: string;
      from?: string;
      to?: string;
      search?: string;
    },
  ) {
    assertPermission(caller, 'payouts.read');
    const limit = requireLimit(input.limit);
    if (input.status && !STATUSES.includes(input.status)) throw new MerchantOpsError('pay.export_filter_invalid', 'bad_request');
    if (input.from && input.to && Date.parse(input.from) > Date.parse(input.to)) {
      throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
    }
    const after = decodeCursor(input.cursor);
    const sql = this.sql;
    const rows = await sql<PayoutRow[]>`
      SELECT s.id::text AS id, s.window, s.asset_id, s.gross::text AS gross, s.fees::text AS fees, s.net::text AS net,
             s.status::text AS status, s.payout_method, s.payout_ref, s.created_at,
             to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
        FROM pay.settlements s
       WHERE s.merchant_id = ${caller.merchantId}
         ${input.status ? sql`AND s.status = ${input.status}::pay.settlement_status` : sql``}
         ${input.assetId ? sql`AND s.asset_id = ${input.assetId}` : sql``}
         ${input.search ? sql`AND s.id::text = lower(${input.search})` : sql``}
         ${input.from ? sql`AND s.created_at >= (${input.from}::text)::timestamptz` : sql``}
         ${input.to ? sql`AND s.created_at < (${input.to}::text)::timestamptz` : sql``}
         ${after ? sql`AND (s.created_at, s.id) < ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT ${limit + 1}`;
    return toPage(
      rows,
      limit,
      (row) => ({
        id: row.id,
        merchantId: caller.merchantId,
        window: row.window,
        assetId: row.asset_id,
        gross: money(row.gross),
        fees: money(row.fees),
        net: money(row.net),
        status: row.status,
        payoutMethod: row.payout_method,
        payoutReference: payoutReference(row.payout_ref),
        createdAt: iso(row.created_at),
      }),
      (row) => encodeCursor(row.cursor_ts, row.id),
    );
  }
}
