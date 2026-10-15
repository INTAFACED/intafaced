import type { Sql } from 'postgres';
import { iso } from './money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * Merchant-scoped KYB view: the CALLER'S merchant only, read-only.
 *
 * It answers "where is my verification" without the operator's side of the
 * story. `kyb.history` (admin:read) stays the operator door.
 *
 * What a merchant never gets here:
 *   - the deciding operator's identity (`actor_id`) - founders are not named;
 *   - the operator's written reason on a decision, because it may contain
 *     internal notes. Only rows the merchant wrote themselves (`actor_scope`
 *     starting `pay:`, e.g. their own submission) keep their reason; on every
 *     other row the transition and its time are shown and `reason` is null.
 */
export class MerchantKybView {
  constructor(private readonly sql: Sql) {}

  async current(caller: MerchantCaller) {
    assertPermission(caller, 'kyb.read');
    const rows = await this.sql<Array<{ kyb_status: string; kyb_ref: string | null; mode: string }>>`
      SELECT kyb_status, kyb_ref, mode FROM pay.merchants WHERE id = ${caller.merchantId}`;
    const r = rows[0]!;
    return { kybStatus: r.kyb_status as 'none' | 'pending' | 'approved' | 'rejected', kybRef: r.kyb_ref, mode: r.mode };
  }

  async history(caller: MerchantCaller, input: { limit?: number | undefined; cursor?: string }) {
    assertPermission(caller, 'kyb.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const sql = this.sql;
    type Row = {
      seq_text: string;
      from_status: string;
      to_status: string;
      kyb_ref: string | null;
      reason: string;
      actor_scope: string;
      created_at: Date;
    };
    const rows = await sql<Row[]>`
      SELECT seq::text AS seq_text, from_status, to_status, kyb_ref, reason, actor_scope, created_at
        FROM pay.merchant_kyb_events
       WHERE merchant_id = ${caller.merchantId}
         ${after ? sql`AND seq < ${after.key}::bigint` : sql``}
       ORDER BY seq DESC
       LIMIT ${limit + 1}`;
    return toPage(
      rows,
      limit,
      (r) => ({
        seq: r.seq_text,
        fromStatus: r.from_status,
        toStatus: r.to_status,
        kybRef: r.kyb_ref,
        decidedBy: r.actor_scope.startsWith('pay:') ? ('merchant' as const) : ('intafaced' as const),
        reason: r.actor_scope.startsWith('pay:') ? r.reason : null,
        at: iso(r.created_at),
      }),
      (r) => encodeCursor('1970-01-01T00:00:00.000000Z', r.seq_text),
    );
  }
}
