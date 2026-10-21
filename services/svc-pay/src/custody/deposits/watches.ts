import type { Sql } from 'postgres';
import type { OpenCryptoPayment } from '../../rails/watch-restore.js';
import { DEPOSIT_USER_REF_PREFIX } from './service.js';

/**
 * Every deposit address already handed to a customer, as a watch to re-register. The watch set lives in the chain object's
 * memory, so a restart empties it, and a deposit sent to an issued address after that would go unseen while the chain cursor
 * moved past it. Re-deriving from the same reference gives back the stored address (the source is a pure function of it).
 */
export async function listIssuedDepositWatches(sql: Sql): Promise<OpenCryptoPayment[]> {
  const rows = await sql<Array<{ user_id: string; asset_id: string }>>`
    SELECT user_id, asset_id FROM pay.custody_deposit_addresses ORDER BY issued_at`;
  return rows.map((row) => ({ paymentId: `${DEPOSIT_USER_REF_PREFIX}${row.user_id}`, assetId: row.asset_id }));
}
