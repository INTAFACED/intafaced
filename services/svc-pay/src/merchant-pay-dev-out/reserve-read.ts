import type { Sql } from 'postgres';
import { z } from 'zod';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { ControlRefusal } from '../control/errors.js';
import { effectiveReserve, loadMerchantControl } from '../control/store.js';

/**
 * M-money-out-01: the merchant's reserve, read only.
 *
 * The rolling reserve is RECORDED on each settlement's pricing snapshot
 * (`reserve_amount`, `reserve_release_at`, `reserve_ledger_status = 'unwired'`)
 * but no ledger recipe books it (control/reserve.ts), so nothing is withheld.
 * This read says exactly that: `holding: 'recorded_not_withheld'`. It never
 * adds the recorded amount to a balance and never moves money.
 *
 * `payoutsRefused` mirrors `assertPayoutReserveWired`: a merchant with an
 * effective reserve rule has fresh payouts refused until the recipe exists.
 */
export const RESERVE_HOLDING = 'recorded_not_withheld' as const;

export const merchantReserveViewSchema = z
  .object({
    merchantId: z.string().uuid(),
    rule: z.object({ rollingReserveBps: z.number().int(), holdDays: z.number().int() }).strict().nullable(),
    holding: z.literal(RESERVE_HOLDING),
    payoutsRefused: z.boolean(),
    assets: z.array(
      z
        .object({
          assetCode: z.string(),
          /** Sum of recorded reserve still inside its hold window. Decimal string. Not held on the ledger. */
          recordedAmount: z.string(),
          entries: z.number().int().nonnegative(),
          nextReleaseAt: z.string().nullable(),
          lastReleaseAt: z.string().nullable(),
        })
        .strict(),
    ),
    readAt: z.string(),
  })
  .strict();
export type MerchantReserveView = z.infer<typeof merchantReserveViewSchema>;

interface Row {
  asset_code: string;
  reserve_amount: string;
  reserve_release_at: Date | null;
}

export async function readMerchantReserve(sql: Sql, merchantId: string, now: Date): Promise<MerchantReserveView> {
  const control = await loadMerchantControl(sql, merchantId);
  const reserve = effectiveReserve(control);
  const rows = await sql<Row[]>`
    SELECT asset_code, reserve_amount::text AS reserve_amount, reserve_release_at
      FROM pay.control_pricing_snapshots
     WHERE merchant_id = ${merchantId}
       AND subject_kind = 'settlement'
       AND reserve_amount IS NOT NULL
       AND reserve_ledger_status = 'unwired'
       AND (reserve_release_at IS NULL OR reserve_release_at > ${now})
     ORDER BY asset_code, reserve_release_at NULLS LAST
  `;
  const byAsset = new Map<string, { sum: Amount; entries: number; next: Date | null; last: Date | null }>();
  for (const row of rows) {
    let amount: Amount;
    try {
      amount = parseAmount(row.reserve_amount);
    } catch (error) {
      const refusal = new ControlRefusal('pay.control_unreadable', 'unavailable');
      Object.defineProperty(refusal, 'internal', { value: error, enumerable: false });
      throw refusal;
    }
    const cur = byAsset.get(row.asset_code) ?? { sum: 0n, entries: 0, next: null, last: null };
    cur.sum += amount;
    cur.entries += 1;
    const at = row.reserve_release_at;
    if (at && (cur.next === null || at < cur.next)) cur.next = at;
    if (at && (cur.last === null || at > cur.last)) cur.last = at;
    byAsset.set(row.asset_code, cur);
  }
  return {
    merchantId,
    rule: reserve ? { rollingReserveBps: reserve.bps, holdDays: reserve.holdDays } : null,
    holding: RESERVE_HOLDING,
    payoutsRefused: reserve !== null,
    assets: [...byAsset.entries()].map(([assetCode, v]) => ({
      assetCode,
      recordedAmount: formatAmount(v.sum),
      entries: v.entries,
      nextReleaseAt: v.next ? v.next.toISOString() : null,
      lastReleaseAt: v.last ? v.last.toISOString() : null,
    })),
    readAt: now.toISOString(),
  };
}
