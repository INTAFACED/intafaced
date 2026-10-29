/**
 * Clearing to available (RC-merchant-10): the rail's word on when a captured payment's funds may settle.
 *
 * A rail that holds captured funds says so on the capture result (`funds: pending`), and the capture appends
 * `funds.pending` to the payment in the same transaction. The rail later releases them with a signed `funds.available`
 * delivery, which appends `funds.available`. Both are rail evidence: nothing a client sends writes either event.
 *
 * A payment with no `funds.pending` was made available at capture (every rail that never reports a hold), so the
 * settlement window reads it exactly as before. A payment with `funds.pending` and no `funds.available` is held: its
 * money stays in clearing, a window does not post it, and a payout of it is refused `pay.payout_clearing_pending`.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { appendEvent } from './internal.js';

/** One held payment, as the window and the Money room read it. `availableOn` is the rail's day, or null when it named none. */
export interface HeldClearing {
  readonly paymentId: string;
  /** Captured minus refunded, a decimal string. */
  readonly amount: string;
  readonly assetId: string;
  readonly availableOn: string | null;
}

/** On capture, in the capture's transaction: the rail reported the funds held. */
export async function recordFundsPending(
  tx: Sql,
  paymentId: string,
  input: { readonly availableOn?: Date; readonly source: 'rail.capture' | 'rail.webhook'; readonly railEventId?: string },
): Promise<void> {
  await appendEvent(tx, paymentId, 'funds.pending', {
    availableOn: input.availableOn ? input.availableOn.toISOString() : null,
    source: input.source,
    railEventId: input.railEventId ?? null,
  });
}

/** From a verified rail delivery only: the rail released the funds. Appending twice is harmless; the first one counts. */
export async function recordFundsAvailable(
  tx: Sql,
  paymentId: string,
  input: { readonly at: Date; readonly railEventId: string },
): Promise<void> {
  await appendEvent(tx, paymentId, 'funds.available', { at: input.at.toISOString(), railEventId: input.railEventId });
}

/** Whether the rail still holds this payment's funds, and the day it last named. */
export async function fundsHeldOf(sql: Sql, paymentId: string): Promise<{ held: boolean; availableOn: string | null }> {
  const rows = await sql<Array<{ pending: boolean; available: boolean; available_on: string | null }>>`
    SELECT
      EXISTS (SELECT 1 FROM pay.payment_events WHERE payment_id = ${paymentId} AND event = 'funds.pending') AS pending,
      EXISTS (SELECT 1 FROM pay.payment_events WHERE payment_id = ${paymentId} AND event = 'funds.available') AS available,
      (SELECT payload->>'availableOn' FROM pay.payment_events
        WHERE payment_id = ${paymentId} AND event = 'funds.pending' ORDER BY seq DESC LIMIT 1) AS available_on
  `;
  const row = rows[0];
  const held = Boolean(row?.pending) && !row?.available;
  return { held, availableOn: held ? (row?.available_on ?? null) : null };
}

/**
 * Every captured payment of one business and asset whose funds the rail still holds: what clearing is waiting on.
 * Captured minus refunded, so the list sums to the held part of clearing.
 */
export async function heldClearingOf(
  sql: Sql,
  merchantId: string,
  assetId?: string,
  /** Only the payments this settlement froze, or that no unreleased settlement holds: one window's excluded set. */
  settlementId?: string,
): Promise<HeldClearing[]> {
  const rows = await sql<Array<{ id: string; currency: string; captured: string; refunded: string; available_on: string | null }>>`
    SELECT p.id, p.currency,
           COALESCE((SELECT SUM((e.payload->>'amount')::numeric) FROM pay.payment_events e
                      WHERE e.payment_id = p.id AND e.event = 'captured'), 0)::text AS captured,
           COALESCE((SELECT SUM((e.payload->>'amount')::numeric) FROM pay.payment_events e
                      WHERE e.payment_id = p.id AND e.event = 'refunded'), 0)::text AS refunded,
           (SELECT e.payload->>'availableOn' FROM pay.payment_events e
             WHERE e.payment_id = p.id AND e.event = 'funds.pending' ORDER BY e.seq DESC LIMIT 1) AS available_on
      FROM pay.payments p
     WHERE p.merchant_id = ${merchantId}
       AND (${assetId ?? null}::text IS NULL OR p.currency = ${assetId ?? null})
       AND p.status = 'captured'
       AND EXISTS (SELECT 1 FROM pay.payment_events e WHERE e.payment_id = p.id AND e.event = 'funds.pending')
       AND NOT EXISTS (SELECT 1 FROM pay.payment_events e WHERE e.payment_id = p.id AND e.event = 'funds.available')
       AND (
         ${settlementId ?? null}::text IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM pay.payment_events s
            WHERE s.payment_id = p.id AND s.event = 'settlement.included'
              AND s.payload->>'settlementId' <> ${settlementId ?? ''}
              AND NOT EXISTS (
                SELECT 1 FROM pay.payment_events r
                 WHERE r.payment_id = s.payment_id AND r.event = 'settlement.released'
                   AND r.payload->>'settlementId' = s.payload->>'settlementId'
              )
         )
       )
     ORDER BY p.created_at, p.id
  `;
  const out: HeldClearing[] = [];
  for (const r of rows) {
    const net = parseAmount(r.captured) - parseAmount(r.refunded);
    if (net <= 0n) continue;
    out.push({ paymentId: r.id, amount: formatAmount(net), assetId: r.currency, availableOn: r.available_on });
  }
  return out;
}

/** The payments one frozen settlement holds whose funds the rail still holds: why that window cannot post or pay out yet. */
export async function heldInSettlementOf(sql: Sql, settlementId: string): Promise<HeldClearing[]> {
  const rows = await sql<Array<{ payment_id: string; amount: string; asset_id: string }>>`
    SELECT s.payment_id, s.payload->>'amount' AS amount, s.payload->>'assetId' AS asset_id
      FROM pay.payment_events s
     WHERE s.event = 'settlement.included' AND s.payload->>'settlementId' = ${settlementId}
       AND NOT EXISTS (
         SELECT 1 FROM pay.payment_events r
          WHERE r.payment_id = s.payment_id AND r.event = 'settlement.released'
            AND r.payload->>'settlementId' = ${settlementId}
       )
     ORDER BY s.payment_id
  `;
  const out: HeldClearing[] = [];
  for (const r of rows) {
    const state = await fundsHeldOf(sql, r.payment_id);
    if (state.held) out.push({ paymentId: r.payment_id, amount: r.amount, assetId: r.asset_id, availableOn: state.availableOn });
  }
  return out;
}

/** The words of `pay.payout_clearing_pending`: the clearing a payout would have spent, named. */
export function clearingPendingMessage(settlementId: string, held: readonly HeldClearing[]): string {
  let total = 0n;
  for (const h of held) total += parseAmount(h.amount);
  const asset = held[0]?.assetId ?? '';
  return `Settlement ${settlementId} is still clearing: ${formatAmount(total)} ${asset} the rail has not made available yet, so there is nothing to pay out`;
}
