import type { Sql } from 'postgres';
import { merchantNotOnTeam } from './errors.js';

/** The principal's user id. Team membership is a row, not a claim in the token. */
export interface ConversionCaller {
  readonly userId: string;
}

/**
 * The caller owns this merchant, or is an active member of its team.
 * A missing merchant and a stranger get the same refusal.
 */
export async function assertOnMerchantTeam(sql: Sql, caller: ConversionCaller, merchantId: string): Promise<{ merchantUserId: string }> {
  const rows = await sql<Array<{ user_id: string }>>`
    SELECT m.user_id
      FROM pay.merchants m
     WHERE m.id = ${merchantId}
       AND (
         m.user_id = ${caller.userId}
         OR EXISTS (
           SELECT 1 FROM pay.merchant_team_members t
            WHERE t.merchant_id = m.id AND t.user_id = ${caller.userId} AND t.status = 'active'
         )
       )
  `;
  const row = rows[0];
  if (!row) throw merchantNotOnTeam();
  return { merchantUserId: row.user_id };
}
