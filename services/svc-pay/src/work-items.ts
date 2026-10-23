import type { Sql } from 'postgres';
import { hasScope } from '@intafaced/auth';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, router, type Context } from '@intafaced/contracts';
import { workItemsOutputSchema, type WorkItem, type WorkItemsOutput } from '@intafaced/contracts/home-work-items';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';

/**
 * HOME WORK LIST, PAY'S PART (HM-dashboard-03): `workItems.list` answers `payout_waiting` for the signed-in person.
 *
 * A payout is waiting when a settlement of the person's own business has posted its net into the business balance
 * (`status = 'posted'`) and nobody has paid it out yet, or when its payout failed and may be sent again (`failed`,
 * except a window released before it posted, which has nothing behind it: `pay.settlement_released`). Moving it on is
 * `settlement.payout`, so the item is an `action` for a session holding `pay:payout` and `info` for one that can only
 * read. Derived on every read from `pay.settlements`; nothing is stored, and the item is gone once the payout is sent
 * (`paid_out`). Only the owner's own business is listed (`merchants.user_id`), not businesses reached by a team seat
 * or a PayFac area grant. The oldest waiting payout comes first; past the contract's cap of 100, the newest are left
 * out (an owner with that many waiting sees the rest on the Payouts page).
 *
 * Left out on purpose, so the list never shows a payout that cannot be sent:
 *   - a business that is not `active` (pending KYB, suspended or closed: payouts are held there);
 *   - a settlement with a sandbox payment in it (a live payout of it refuses `pay.sandbox_live_account_refused`).
 *
 * Every signed-in person may ask, because Home asks for everyone: a caller with no business, or whose session carries
 * neither `pay:onboard` nor `pay:read` (an API key or a sub-account without them), or a sandbox key (live payouts are
 * not its to see), gets an empty answer, not an error. A scope the owner grant has withdrawn counts as not held; any
 * other failure of that recheck is an error, never an empty list.
 */

/** The copy key the customer app words. */
export const PAYOUT_WAITING_TITLE = 'pay.payout_waiting';
/** At most this many rows per answer; the contract caps an answer at 100. */
export const PAYOUT_WAITING_LIMIT = 100;

export interface WaitingPayout {
  settlementId: string;
  /** Decimal string as the database holds it. */
  net: string;
  assetId: string;
  /** The failed payout's catalog code, when the payout failed; null while it has not been tried. */
  failureCode: string | null;
}

/** The read behind the item, by the owner's user id. */
export interface PayoutWaitingSource {
  waiting(userId: string): Promise<WaitingPayout[]>;
}

export function payoutWaitingFromSql(sql: Sql): PayoutWaitingSource {
  return {
    async waiting(userId) {
      const rows = await sql<Array<{ id: string; net: string; asset_id: string; status: string; failure_code: string | null }>>`
        SELECT s.id, s.net::text AS net, s.asset_id, s.status, s.failure_code
          FROM pay.settlements s
          JOIN pay.merchants m ON m.id = s.merchant_id
         WHERE m.user_id = ${userId}
           AND m.status = 'active'
           AND (s.status = 'posted' OR (s.status = 'failed' AND s.failure_code IS DISTINCT FROM 'pay.settlement_released'))
           AND NOT EXISTS (
                 SELECT 1
                   FROM pay.payment_events inc
                   JOIN pay.payment_events created
                     ON created.payment_id = inc.payment_id AND created.event = 'created'
                  WHERE inc.event = 'settlement.included'
                    AND inc.payload->>'settlementId' = s.id::text
                    AND created.payload->>'sandbox' = 'true'
               )
         ORDER BY s.settled_at ASC NULLS LAST, s.id ASC
         LIMIT ${PAYOUT_WAITING_LIMIT}
      `;
      return rows.map((row) => ({
        settlementId: row.id,
        net: row.net,
        assetId: row.asset_id,
        failureCode: row.status === 'failed' ? (row.failure_code ?? 'pay.payout_failed') : null,
      }));
    },
  };
}

const CODE = /^[a-z][a-z0-9]*([._][a-z0-9]+)*$/;

/** One item per waiting payout, linked to that payout's own page. `canSend`: the session holds `pay:payout`. */
export function payoutWaitingItems(rows: readonly WaitingPayout[], canSend: boolean): WorkItem[] {
  return rows.map((row) => ({
    id: `payout_waiting:${row.settlementId}`,
    kind: 'payout_waiting',
    source: 'pay',
    severity: canSend ? 'action' : 'info',
    titleKey: PAYOUT_WAITING_TITLE,
    link: `/pay/payouts/${encodeURIComponent(row.settlementId)}`,
    // Through the scaled bigint, so the wire never carries a float or the column's trailing zeros.
    amount: { value: formatAmount(parseAmount(row.net)), asset: row.assetId },
    // A failed payout says why, when its code is a catalog code; anything else is not sent.
    ...(row.failureCode && CODE.test(row.failureCode) ? { reasonCode: row.failureCode } : {}),
  }));
}

const PAY_SCOPES = ['pay:onboard', 'pay:read'] as const;

/** Whether the session may see its own business's payouts: it holds a pay scope the live owner grant still allows. */
async function mayReadOwnPayouts(ctx: Context & { principal: NonNullable<Context['principal']> }): Promise<boolean> {
  for (const scope of PAY_SCOPES) {
    if (!hasScope(ctx.principal.scopes, scope)) continue;
    if (!ctx.ownerPayGrant) return true;
    try {
      await ctx.ownerPayGrant.assertStillGranted(ctx.principal, scope);
      return true;
    } catch (err) {
      // A withdrawn grant: try the next scope, as anyScopeProcedure does. Anything else (the lookup failed) is an error.
      if (!(err instanceof TRPCError && err.message === 'pay.owner_grant_withdrawn')) throw err;
    }
  }
  return false;
}

/** `workItems.list` (the contract's `WORK_ITEMS_PROCEDURE`), answered for the signed principal only. */
export function createWorkItemsRouter(source: PayoutWaitingSource) {
  return router({
    workItems: router({
      list: protectedProcedure.output(workItemsOutputSchema).query(async ({ ctx }): Promise<WorkItemsOutput> => {
        if (ctx.principal.key_env === 'sandbox' || !(await mayReadOwnPayouts(ctx))) return { items: [] };
        const canSend = hasScope(ctx.principal.scopes, 'pay:payout');
        return { items: payoutWaitingItems(await source.waiting(ctx.principal.userId), canSend) };
      }),
    }),
  });
}
