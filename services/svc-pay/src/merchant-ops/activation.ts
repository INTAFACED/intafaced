import type { Sql } from 'postgres';
import type { MerchantActivation } from '@intafaced/contracts/merchant-activation';
import { MerchantOpsError } from './errors.js';
import { iso } from './money.js';
import { assertPermission, type MerchantCaller } from './roles.js';

type Status = 'pending' | 'active' | 'suspended' | 'closed';

/**
 * Merchant-scoped activation read (J-merchant-02 step 6): the CALLER'S business only, read-only, `kyb.read` like the
 * verification view beside it.
 *
 * The truth is svc-pay's own record of the business's status: `pay.merchants.status`, which every money door enforces,
 * and `pay.merchant_status_events`, the append-only history its one writer (`MerchantStateService`, and the founder
 * account controls) writes in the same transaction. An activation is confirmed only when the newest history row moves
 * the business to `active` and the column still says `active`; its time is that row's time.
 *
 * Deliberately NOT read from:
 *   - `kyb_status`: deciding the verification never writes the status, so an approved verification is not an activation;
 *   - the column alone: every account opens `active` with no history row, and an unrecorded default is not a
 *     confirmation anyone made.
 * The operator's id and written reason stay out, as in the verification view.
 */
export class MerchantActivationView {
  constructor(private readonly sql: Sql) {}

  async get(caller: MerchantCaller): Promise<MerchantActivation> {
    assertPermission(caller, 'kyb.read');
    const rows = await this.sql<Array<{ status: Status; last_to: Status | null; last_at: Date | null }>>`
      SELECT m.status::text AS status, e.to_status::text AS last_to, e.created_at AS last_at
        FROM pay.merchants m
        LEFT JOIN LATERAL (
          SELECT to_status, created_at
            FROM pay.merchant_status_events
           WHERE merchant_id = m.id
           ORDER BY seq DESC
           LIMIT 1
        ) e ON true
       WHERE m.id = ${caller.merchantId}`;
    const row = rows[0];
    // The caller was resolved from this row a moment ago; a vanished row is not "unconfirmed", it is no answer.
    if (!row) throw new MerchantOpsError('pay.merchant_ops_not_merchant', 'not_found');
    return activationOf(row.status, row.last_to, row.last_at);
  }
}

/** The answer from the current status and the newest status-history row (or none). Exported for the unit test. */
export function activationOf(status: Status, lastTo: Status | null, lastAt: Date | null): MerchantActivation {
  if (status !== 'active') return { activation: 'unconfirmed', status, activatedAt: null, reason: 'not_active' };
  if (lastTo === 'active' && lastAt) return { activation: 'confirmed', status: 'active', activatedAt: iso(lastAt) };
  return { activation: 'unconfirmed', status, activatedAt: null, reason: 'no_activation_record' };
}
