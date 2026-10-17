import type { Sql } from 'postgres';
import { maskDestination, safeDestinationLabel } from '../control/mask-destination.js';
import type { PayFail } from './common.js';
import { assertPortalPageLimit, portalFilters, pageCursor } from './common.js';

/**
 * DESTINATION INVENTORY — read only.
 *
 * Main's destination write is `merchant.setPayoutDestination`: one row per
 * rail, overwritten by the owner. It is not a reviewed action and it does not
 * ask for step-up. A payout approval is voided when the destination that
 * payout would use changes afterwards. That voids the payout request. It is
 * not an approval to change the saved destination.
 *
 * set-default and remove are not procedures. There is no default column — one
 * row per rail is that rail's destination — and W9 does not store a destination
 * screening verdict. `defaultFlag` stays `unset`. `screeningState` stays
 * `not_recorded`. `lastUsedAt` is the latest paid-out send on that rail, or null.
 */
export const DESTINATION_CHANGE_FLOW = 'absent' as const;

export interface PayoutDestinationItem {
  id: string;
  merchantId: string;
  railId: string;
  kind: string;
  destinationMasked: string;
  screeningState: 'not_recorded';
  defaultFlag: 'unset';
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listMerchantPayoutDestinations(
  sql: Sql,
  input: { merchantId: string; limit?: number; cursor?: string },
  fail: PayFail,
): Promise<{ items: PayoutDestinationItem[]; nextCursor: string | null }> {
  const limit = assertPortalPageLimit(input.limit, 'pay.destination_list_limit_unset', 'merchant.payoutDestinations.list', fail);
  const filters = portalFilters({ cursor: input.cursor }, fail);
  const cursorAt = filters.cursor?.createdAtCursor ?? null;
  const cursorId = filters.cursor?.id ?? null;
  const rows = await sql<
    Array<{
      id: string;
      rail_id: string;
      kind: string;
      ref: string;
      created_at: Date;
      created_at_cursor: string;
      last_used_at: string | null;
    }>
  >`
    SELECT d.id, d.rail_id, d.kind, d.ref, d.created_at,
           to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
           (
             SELECT to_char(max(s.sent_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               FROM pay.settlements s
              WHERE s.merchant_id = d.merchant_id
                AND s.payout_method = d.rail_id
                AND s.status = 'paid_out'
                AND s.sent_at IS NOT NULL
           ) AS last_used_at
      FROM pay.merchant_payout_destinations d
     WHERE d.merchant_id = ${input.merchantId}
       AND (
         ${cursorAt}::timestamptz IS NULL
         OR (d.created_at, d.id) < (${cursorAt}::timestamptz, ${cursorId}::uuid)
       )
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      merchantId: input.merchantId,
      railId: safeDestinationLabel(row.rail_id, row.ref),
      kind: safeDestinationLabel(row.kind, row.ref),
      destinationMasked: maskDestination(row.kind, row.ref),
      screeningState: 'not_recorded' as const,
      defaultFlag: 'unset' as const,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    })),
    nextCursor: pageCursor(rows, limit),
  };
}
