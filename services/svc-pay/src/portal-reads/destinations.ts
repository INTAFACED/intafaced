import type { Sql } from 'postgres';
import { maskDestination, safeDestinationLabel } from '../control/mask-destination.js';
import type { PayFail } from './common.js';
import { lifecycleOfColumns, promoteDueHeldDestinations, type DestinationLifecycle } from '../merchant-payout-destination.js';
import { assertPortalPageLimit, portalFilters, pageCursor } from './common.js';

/**
 * DESTINATION INVENTORY.
 *
 * `merchant.payoutDestinations.add` saves the one row for a rail unverified
 * (no step-up; not payable). `merchant.setPayoutDestination` and
 * `merchant.payoutDestinations.change` verify it with step-up: it is then
 * held until `activatesAt` and active after. Changing a verified one needs
 * step-up and the hold. Each item carries `state` and `activatesAt`. A payout cannot name
 * a destination. Remove applies only to unverified rows. A verified
 * destination changes only through step-up plus the hold. Set-default is an
 * owner write: it does not change the paid ref, and it needs no second
 * approval.
 * A payout approval is voided when the stored destination that payout would
 * use changes afterwards. That voids the payout request. It is not an
 * approval to change the saved destination.
 *
 * `defaultFlag` is `default` only after the owner marks that row. Existing
 * rows stay `unset`. Removing the marked row does not promote another one.
 * `screeningState` stays `not_recorded`. `lastUsedAt` is the latest paid-out
 * send on that rail, or null.
 *
 * Remove of an unverified row refuses while a payout that still names this
 * rail, kind and ref is in flight: a live approval (pending or approved, not
 * yet expired) or a payout admission that has not reached a terminal outcome.
 * A verified row is refused before that check, and nothing is deleted.
 *
 * An admission with no outcome stays in flight however old it is: recovery
 * pays to the destination copied onto the admission, so removing it early
 * would not stop that payout. Re-running `payoutSettlement` is what writes
 * the terminal outcome (settled, reversed, rail_refused, or identity_cancelled).
 */
export const DESTINATION_CHANGE_FLOW = 'step_up_hold' as const;
/** Remove and set-default. They do not consume the step-up change door. */
export const DESTINATION_DEFAULT_REMOVE_FLOW = 'owner_write' as const;

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
  /** J-merchant-02 #5: `unverified` (saved, not payable), `held` until `activatesAt`, or `active`. */
  state: DestinationLifecycle;
  /** When a held destination becomes active. Null unless `state` is `held`. */
  activatesAt: string | null;
}

type StateColumns = { verified: boolean; activates_at: Date | null };

function lifecycleOf(row: StateColumns, now: Date): Pick<PayoutDestinationItem, 'state' | 'activatesAt'> {
  const life = lifecycleOfColumns(row, now);
  return { state: life.state, activatesAt: life.activatesAt?.toISOString() ?? null };
}

export async function listMerchantPayoutDestinations(
  sql: Sql,
  input: { merchantId: string; limit?: number; cursor?: string },
  fail: PayFail,
  now: Date = new Date(),
): Promise<{ items: PayoutDestinationItem[]; nextCursor: string | null }> {
  const limit = assertPortalPageLimit(input.limit, 'pay.destination_list_limit_unset', 'merchant.payoutDestinations.list', fail);
  const filters = portalFilters({ cursor: input.cursor }, fail);
  const cursorAt = filters.cursor?.createdAtCursor ?? null;
  const cursorId = filters.cursor?.id ?? null;
  // A held row whose hold has passed is stored active before it is listed.
  await promoteDueHeldDestinations(sql, input.merchantId, now);
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
      verified: boolean;
      activates_at: Date | null;
    }>
  >`
    SELECT d.id, d.rail_id, d.kind, d.ref, d.is_default, d.created_at, d.verified, d.activates_at,
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
      ...lifecycleOf(row, now),
    })),
    nextCursor: pageCursor(rows, limit),
  };
}

interface DestinationRow extends StateColumns {
  id: string;
  rail_id: string;
  kind: string;
  ref: string;
  is_default: boolean;
  created_at: Date;
}

function toItem(merchantId: string, row: DestinationRow, lastUsedAt: string | null, now: Date): PayoutDestinationItem {
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
    ...lifecycleOf(row, now),
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
  now: Date = new Date(),
): Promise<PayoutDestinationItem> {
  const updated = await sql.begin(async (tx) => {
    const locked = await tx<DestinationRow[]>`
      SELECT id, rail_id, kind, ref, is_default, created_at, verified, activates_at
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
       RETURNING id, rail_id, kind, ref, is_default, created_at, verified, activates_at,
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
  return toItem(input.merchantId, updated, updated.last_used_at ? new Date(updated.last_used_at).toISOString() : null, now);
}

/**
 * Delete one unverified destination. A verified row (held or active),
 * including one with a pending change, is refused (`pay.payout_destination_verified_locked`) and
 * nothing is deleted. A verified destination changes only through step-up
 * plus the hold. An unverified row is still refused while a payout that
 * names this rail, kind and ref has not finished, then deleted. Does not
 * promote another default.
 */
export async function removeMerchantPayoutDestination(
  sql: Sql,
  input: { merchantId: string; destinationId: string },
  fail: PayFail,
): Promise<{ removed: true }> {
  const outcome = await sql.begin(async (tx) => {
    const locked = await tx<DestinationRow[]>`
      SELECT id, rail_id, kind, ref, is_default, created_at, verified, activates_at
        FROM pay.merchant_payout_destinations
       WHERE id = ${input.destinationId} AND merchant_id = ${input.merchantId}
         FOR UPDATE
    `;
    const row = locked[0];
    if (!row) return 'missing' as const;
    // Held (verified, waiting out the hold; stored `verified = false` with `activates_at`) is locked like active: a
    // verified destination changes only through step-up plus the hold, never through remove.
    if (row.verified || row.activates_at !== null) return 'verified_locked' as const;
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
  if (outcome === 'verified_locked') {
    fail('a verified payout destination cannot be removed', 'pay.payout_destination_verified_locked');
  }
  if (outcome === 'in_flight') fail('payout destination is in use', 'pay.payout_destination_in_flight');
  return { removed: true };
}
