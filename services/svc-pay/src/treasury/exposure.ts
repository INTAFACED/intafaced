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
 *     default source is `wired: false` and reports zero: no conversion path
 *     exists to hold any, and `beforeConversion` REFUSES while it is unwired so
 *     the zero can never be relied on by a real conversion.
 *
 * NOT counted (stated, not hidden): user-money withdrawals (`pay.withdrawals`).
 */

export interface ConversionInventorySource {
  /** False until the conversion path provides its own reader. */
  readonly wired: boolean;
  /** Open (placed, not yet paid out or unwound) conversion size in `assetId` terms. */
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
  return parseAmount(rows[0]!.total);
}

export interface AssetExposure {
  readonly assetId: string;
  readonly openConversionInventory: Amount;
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
    openConversionInventory: await inventory.openInventory(conn, assetId),
    pendingPayouts: await pendingPayoutExposure(conn, assetId),
    limit: limits.byAsset.get(assetId) ?? null,
  };
}

/** Operator view, in the shape of `founderTreasuryExposureSchema.perAsset`. Every asset with a limit or any pending payout. */
export async function treasuryExposureView(sql: Sql, limits: TreasuryLimits, inventory: ConversionInventorySource) {
  const pending = await sql<Array<{ asset_id: string }>>`SELECT DISTINCT asset_id FROM pay.payout_admissions`;
  const assets = [...new Set([...limits.byAsset.keys(), ...pending.map((r) => r.asset_id)])].sort();
  const perAsset = [];
  for (const assetId of assets) {
    const e = await assetExposure(sql, assetId, limits, inventory);
    perAsset.push({
      assetCode: assetId,
      openConversionInventory: formatAmount(e.openConversionInventory),
      pendingPayouts: formatAmount(e.pendingPayouts),
      limit: e.limit === null ? null : formatAmount(e.limit),
    });
  }
  return perAsset;
}
