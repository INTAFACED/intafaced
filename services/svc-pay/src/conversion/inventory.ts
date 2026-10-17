import type { Sql } from 'postgres';
import { ZERO, conversionInventory, parseAmount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { ConversionInventorySource } from '../treasury/exposure.js';

/**
 * Open conversion inventory for the W5 exposure cap.
 *
 * Counts from-asset size that is reserved or resting and not yet booked:
 * `intent_committed`, `placing` and `placed`. A partial that has been booked
 * already cancelled its remainder, so that remainder is not exposure. A missing
 * table throws — the caller must treat that as "not measured", never as zero.
 *
 * A negative `pay:fx-inventory` balance is a short already owed. It is added
 * when a ledger is wired. Without one, the short is not readable and is not
 * reported as zero by this function's caller on the conversion path — the
 * quote itself refuses while the balance is negative.
 */
export function createConversionInventory(_sql: Sql, ledger?: Pick<LedgerClient, 'balance'>): ConversionInventorySource {
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
      let open = total === undefined ? ZERO : parseAmount(total);
      if (ledger) {
        const held = await ledger.balance(conversionInventory(assetId));
        if (held.amount < 0n) open += -held.amount;
      }
      return open;
    },
  };
}
