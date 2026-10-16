import type { Sql } from 'postgres';
import { ZERO, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { ConversionInventorySource } from '../treasury/exposure.js';

/**
 * Open conversion inventory for the W5 exposure cap.
 *
 * Counts from-asset size that is reserved or resting and not yet booked:
 * `intent_committed`, `placing` and `placed`. A partial that has been booked
 * already cancelled its remainder, so that remainder is not exposure. A missing
 * table throws — the caller must treat that as "not measured", never as zero.
 */
export function createConversionInventory(_sql: Sql): ConversionInventorySource {
  return {
    wired: true,
    async openInventory(conn: Sql, assetId: string): Promise<Amount> {
      const rows = await conn<Array<{ total: string }>>`
        SELECT COALESCE(SUM(from_amount), 0)::text AS total
          FROM pay.conversion_orders
         WHERE from_asset = ${assetId}
           AND status IN ('intent_committed', 'placing', 'placed')
      `;
      const total = rows[0]?.total;
      if (total === undefined) return ZERO;
      return parseAmount(total);
    },
  };
}
