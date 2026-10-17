import type { Sql } from 'postgres';
import { maskDestination, safeDestinationLabel } from '../control/mask-destination.js';
import type { PayFail } from './common.js';
import { assertPortalPageLimit, portalFilters, pageCursor } from './common.js';

/**
 * DESTINATION INVENTORY.
 *
 * `merchant.setPayoutDestination` still overwrites the one row for a rail. It
 * is not a reviewed action and it does not ask for step-up. Remove and
 * set-default follow that same owner write: no second approval, because the
 * add does not have one. A payout approval is voided when the destination
 * that payout would use changes afterwards. That voids the payout request.
 * It is not an approval to change the saved destination.
 *
 * `defaultFlag` is `default` only after the owner marks that row. Existing
 * rows stay `unset`. Removing the marked row does not promote another one.
 * `screeningState` stays `not_recorded`. `lastUsedAt` is the latest paid-out
 * send on that rail, or null.
 *
 * Remove refuses while a payout that still names this rail, kind and ref is
 * in flight: a live approval (pending or approved, not yet expired) or a
 * payout admission that has not reached a terminal outcome.
 *
 * An admission with no outcome stays in flight however old it is: recovery
 * pays to the destination copied onto the admission, so removing it early
 * would not stop that payout. Re-running `payoutSettlement` is what writes
 * the terminal outcome (settled, reversed, rail_refused, or identity_cancelled).
 */
export const DESTINATION_CHANGE_FLOW = 'owner_write' as const;

export interface PayoutDestinationItem {
  id: string;
  merchantId: string;
  railId: string;
  kind: string;
  destinationMasked: string;
  screeningState: 'not_recorded';
  defaultFlag: 'unset' | 'default';
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
      is_default: boolean;
      created_at: Date;
      created_at_cursor: string;
      last_used_at: string | null;
    }>
  >`
    SELECT d.id, d.rail_id, d.kind, d.ref, d.is_default, d.created_at,
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
      defaultFlag: row.is_default ? ('default' as const) : ('unset' as const),
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    })),
    nextCursor: pageCursor(rows, limit),
  };
}

interface DestinationRow {
  id: string;
  rail_id: string;
  kind: string;
  ref: string;
  is_default: boolean;
  created_at: Date;
}

function toItem(merchantId: string, row: DestinationRow, lastUsedAt: string | null): PayoutDestinationItem {
  return {
    id: row.id,
    merchantId,
    railId: safeDestinationLabel(row.rail_id, row.ref),
    kind: safeDestinationLabel(row.kind, row.ref),
    destinationMasked: maskDestination(row.kind, row.ref),
    screeningState: 'not_recorded',
    defaultFlag: row.is_default ? 'default' : 'unset',
    createdAt: row.created_at.toISOString(),
    lastUsedAt,
  };
}

function notFound(fail: PayFail): never {
  return fail('payout destination not found', 'pay.payout_destination_not_found');
}

/**
 * Mark one saved destination as the merchant's default. Clears any previous
 * mark in the same transaction. Does not change the ref a payout reads.
 */
export async function setDefaultMerchantPayoutDestination(
  sql: Sql,
  input: { merchantId: string; destinationId: string },
  fail: PayFail,
): Promise<PayoutDestinationItem> {
  const updated = await sql.begin(async (tx) => {
    const locked = await tx<DestinationRow[]>`
      SELECT id, rail_id, kind, ref, is_default, created_at
        FROM pay.merchant_payout_destinations
       WHERE merchant_id = ${input.merchantId}
       ORDER BY id
         FOR UPDATE
    `;
    const row = locked.find((candidate) => candidate.id === input.destinationId);
    if (!row) return null;
    await tx`
      UPDATE pay.merchant_payout_destinations
         SET is_default = false
       WHERE merchant_id = ${input.merchantId} AND is_default AND id <> ${row.id}
    `;
    const saved = await tx<Array<DestinationRow & { last_used_at: string | null }>>`
      UPDATE pay.merchant_payout_destinations
         SET is_default = true, updated_at = now()
       WHERE merchant_id = ${input.merchantId} AND id = ${row.id}
       RETURNING id, rail_id, kind, ref, is_default, created_at,
         (
           SELECT to_char(max(s.sent_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             FROM pay.settlements s
            WHERE s.merchant_id = pay.merchant_payout_destinations.merchant_id
              AND s.payout_method = pay.merchant_payout_destinations.rail_id
              AND s.status = 'paid_out'
              AND s.sent_at IS NOT NULL
         ) AS last_used_at
    `;
    return saved[0] ?? null;
  });
  if (!updated) return notFound(fail);
  return toItem(input.merchantId, updated, updated.last_used_at ? new Date(updated.last_used_at).toISOString() : null);
}

/**
 * Delete one saved destination. Refuses while a payout that still names this
 * rail, kind and ref has not finished. Does not promote another default.
 */
export async function removeMerchantPayoutDestination(
  sql: Sql,
  input: { merchantId: string; destinationId: string },
  fail: PayFail,
): Promise<{ removed: true }> {
  const outcome = await sql.begin(async (tx) => {
    const locked = await tx<DestinationRow[]>`
      SELECT id, rail_id, kind, ref, is_default, created_at
        FROM pay.merchant_payout_destinations
       WHERE id = ${input.destinationId} AND merchant_id = ${input.merchantId}
         FOR UPDATE
    `;
    const row = locked[0];
    if (!row) return 'missing' as const;
    const live = await tx<Array<{ live: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pay.control_payout_approvals a
         WHERE a.merchant_id = ${input.merchantId}
           AND a.rail_id = ${row.rail_id}
           AND a.destination_kind = ${row.kind}
           AND a.destination_ref = ${row.ref}
           AND a.status IN ('pending', 'approved')
           AND a.expires_at > now()
      ) OR EXISTS (
        SELECT 1 FROM pay.payout_admissions p
         WHERE p.merchant_id = ${input.merchantId}
           AND p.rail_id = ${row.rail_id}
           AND p.destination_kind = ${row.kind}
           AND p.destination_ref = ${row.ref}
           AND NOT EXISTS (
             SELECT 1 FROM pay.payout_outcomes o
              WHERE o.admission_id = p.id
                AND o.kind IN ('settled', 'reversed', 'identity_cancelled', 'rail_refused')
           )
      ) AS live
    `;
    if (live[0]?.live) return 'in_flight' as const;
    await tx`
      DELETE FROM pay.merchant_payout_destinations
       WHERE id = ${row.id} AND merchant_id = ${input.merchantId}
    `;
    return 'removed' as const;
  });
  if (outcome === 'missing') notFound(fail);
  if (outcome === 'in_flight') fail('payout destination is in use', 'pay.payout_destination_in_flight');
  return { removed: true };
}
