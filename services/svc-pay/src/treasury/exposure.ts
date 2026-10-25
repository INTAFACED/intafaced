import type { Sql } from 'postgres';
import { ZERO, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { TreasuryLimits } from './config.js';

/**
 * TREASURY EXPOSURE, per asset = open conversion inventory + pending payouts.
 *
 * This is a READ of the books that already exist, never a second money book:
 *   - pending payouts: the payout admission book (`pay.payout_admissions`) minus
 *     every admission that reached a terminal outcome (`settled`, `reversed` or
 *     `identity_cancelled`). An admission whose rail accepted but has not yet
 *     settled is still pending; money has not left.
 *   - open conversion inventory: owned by the conversion path (W6). It supplies a
 *     `ConversionInventorySource` reading its own order table. Until it does, the
 *     default source is `wired: false` and exposure reports NULL ("not measured"),
 *     never zero: a zero would read as an empty book. Limit arithmetic counts it
 *     as nothing, and `beforeConversion` REFUSES while it is unwired so the gap
 *     can never be relied on by a real conversion.
 *
 * User-money withdrawals (`pay.withdrawals` in `pending` or `held`) count as
 * pending payouts too: that value is on its way off the platform. `sent` and
 * `failed` do not, and neither does an internal withdrawal (rail `internal`,
 * W-withdraw-14): it moves value between two accounts and never leaves custody.
 */

export interface ConversionInventorySource {
  /** False until the conversion path provides its own reader. */
  readonly wired: boolean;
  /** Open (placed, not yet paid out or unwound) conversion size in `assetId` terms. Read only when `wired`. */
  openInventory(conn: Sql, assetId: string): Promise<Amount>;
}

export const UNWIRED_CONVERSION_INVENTORY: ConversionInventorySource = Object.freeze({
  wired: false,
  openInventory: async () => ZERO,
});

export async function pendingPayoutExposure(conn: Sql, assetId: string): Promise<Amount> {
  const rows = await conn<Array<{ total: string }>>`
    SELECT COALESCE(SUM(a.net), 0)::text AS total
      FROM pay.payout_admissions a
     WHERE a.asset_id = ${assetId}
       AND NOT EXISTS (
         SELECT 1 FROM pay.payout_outcomes o
          WHERE o.admission_id = a.id AND o.kind IN ('settled', 'reversed', 'identity_cancelled')
       )
  `;
  const withdrawals = await conn<Array<{ total: string }>>`
    SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM pay.withdrawals
     WHERE asset_id = ${assetId} AND status IN ('pending', 'held') AND rail <> 'internal'
  `;
  return parseAmount(rows[0]!.total) + parseAmount(withdrawals[0]!.total);
}

export interface AssetExposure {
  readonly assetId: string;
  /** Null = the conversion inventory reader is not wired, so nothing was measured. */
  readonly openConversionInventory: Amount | null;
  readonly pendingPayouts: Amount;
  /** Null = no limit configured (which REFUSES, it is not unlimited). */
  readonly limit: Amount | null;
}

export async function assetExposure(
  conn: Sql,
  assetId: string,
  limits: TreasuryLimits,
  inventory: ConversionInventorySource,
): Promise<AssetExposure> {
  return {
    assetId,
    openConversionInventory: inventory.wired ? await inventory.openInventory(conn, assetId) : null,
    pendingPayouts: await pendingPayoutExposure(conn, assetId),
    limit: limits.byAsset.get(assetId) ?? null,
  };
}

/** Operator view, in the shape of `founderTreasuryExposureSchema.perAsset`. Every asset with a limit or any pending payout. */
export async function treasuryExposureView(sql: Sql, limits: TreasuryLimits, inventory: ConversionInventorySource) {
  const pending = await sql<Array<{ asset_id: string }>>`
    SELECT asset_id FROM pay.payout_admissions UNION SELECT asset_id FROM pay.withdrawals WHERE status IN ('pending', 'held') AND rail <> 'internal'
  `;
  const assets = [...new Set([...limits.byAsset.keys(), ...pending.map((r) => r.asset_id)])].sort();
  const perAsset = [];
  for (const assetId of assets) {
    const e = await assetExposure(sql, assetId, limits, inventory);
    perAsset.push({
      assetCode: assetId,
      openConversionInventory: e.openConversionInventory === null ? null : formatAmount(e.openConversionInventory),
      pendingPayouts: formatAmount(e.pendingPayouts),
      limit: e.limit === null ? null : formatAmount(e.limit),
    });
  }
  return perAsset;
}
