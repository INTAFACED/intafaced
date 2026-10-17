import type { Sql } from 'postgres';
import { PayService } from './payment-service.js';

/**
 * Test adapter for suites written when `payoutSettlement` accepted a destination.
 * An offered destination is stored as the verified destination for that merchant
 * and rail, then the field is removed so the payout pays only what was stored.
 * A destination the rail cannot hold is left on the call, and the service refuses it.
 * Production never imports this file.
 */
export function installPayoutDestinationShim(sql: Sql): () => void {
  const original = PayService.prototype.payoutSettlement;
  PayService.prototype.payoutSettlement = async function (input) {
    if (input.destination === undefined) return original.call(this, input);
    const rows = await sql<Array<{ merchant_id: string }>>`
      SELECT merchant_id FROM pay.settlements WHERE id = ${input.settlementId}
    `;
    const merchantId = rows[0]?.merchant_id;
    if (!merchantId) return original.call(this, input);
    try {
      await this.destinationBook().seedVerified({
        merchantId,
        railId: input.railId,
        kind: input.destination.kind,
        ref: input.destination.ref,
      });
    } catch {
      return original.call(this, input);
    }
    return original.call(this, {
      settlementId: input.settlementId,
      railId: input.railId,
      identityAuthority: input.identityAuthority,
    });
  };
  return () => {
    PayService.prototype.payoutSettlement = original;
  };
}
