import type { Sql } from 'postgres';
import { ZERO, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { ConversionInventorySource } from '../treasury/exposure.js';

/**
 * Open conversion inventory for the W5 exposure cap.
 *
 * Counts from-asset size that is committed at a venue and not yet booked or
 * unwound: a fresh intent, a resting order, and the unfilled remainder of a
 * partial. Filled, failed, reversed and expired rows are done. A missing table
 * throws — the caller must treat that as "not measured", never as zero.
 */
export function createConversionInventory(_sql: Sql): ConversionInventorySource {
  return {
    wired: true,
    async openInventory(conn: Sql, assetId: string): Promise<Amount> {
      const rows = await conn<Array<{ total: string }>>`
        SELECT COALESCE(SUM(GREATEST(from_amount - filled_from_amount, 0)), 0)::text AS total
          FROM pay.conversion_orders
         WHERE from_asset = ${assetId}
           AND status IN ('intent_committed', 'placed', 'partially_filled')
      `;
      const total = rows[0]?.total;
      if (total === undefined) return ZERO;
      return parseAmount(total);
    },
  };
}
