/**
 * Identity's part of the Home work list (HM-dashboard-03): `workItems.list` answers the signed person's `verification`
 * item, derived from their newest KYC record and never stored. One item at most:
 *
 * - no record at all: `action`, start verification (id `verification:<user id>`, the account is the record);
 * - newest record pending: `info`, waiting on review;
 * - newest record rejected: `action`, see why and submit again;
 * - newest record expired, or approved with its expiry passed: `action`, verify again (`dueAt` is the expiry);
 * - newest record approved and live: nothing.
 *
 * A person who still holds a live approval owes nothing when a newer attempt (an upgrade) was rejected or lapsed: they
 * are verified, and asking them to act would be a false alarm. A pending upgrade still shows as `info`.
 *
 * The owner sends copy keys, never sentences, and links only into its own rooms (`/verification`).
 */
import { protectedProcedure, router, TRPCError, workItemsOutputSchema, type WorkItem, type WorkItemsOutput } from '@intafaced/contracts';
import type { Sql } from 'postgres';

type NewestRecord = {
  readonly id: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired';
  readonly expires_at: Date | null;
};

const LINK = '/verification';

/**
 * The verification item for one person's newest KYC record (null: none at all), as of `now`. `liveApproval` says
 * whether any of their records is approved and not past its expiry.
 */
export function verificationItem(userId: string, newest: NewestRecord | null, now: Date, liveApproval = false): WorkItem | null {
  const item = (id: string, severity: WorkItem['severity'], titleKey: string, dueAt?: Date): WorkItem => ({
    id: `verification:${id}`,
    kind: 'verification',
    source: 'identity',
    severity,
    titleKey,
    link: LINK,
    ...(dueAt ? { dueAt: dueAt.toISOString() } : {}),
  });
  if (!newest) return item(userId, 'action', 'identity.verification.start');
  if (newest.status === 'pending') return item(newest.id, 'info', 'identity.verification.pending');
  if (liveApproval) return null;
  if (newest.status === 'rejected') return item(newest.id, 'action', 'identity.verification.rejected');
  const lapsed = newest.status === 'expired' || (newest.expires_at !== null && newest.expires_at.getTime() <= now.getTime());
  if (lapsed) return item(newest.id, 'action', 'identity.verification.expired', newest.expires_at ?? undefined);
  return null;
}

export async function listVerificationItems(sql: Sql, userId: string, now = new Date()): Promise<WorkItemsOutput> {
  const rows = await sql<Array<NewestRecord & { live: boolean }>>`
    SELECT id, status, expires_at,
           EXISTS (
             SELECT 1 FROM kyc_records a
              WHERE a.user_id = ${userId} AND a.status = 'approved' AND (a.expires_at IS NULL OR a.expires_at > ${now})
           ) AS live
      FROM kyc_records WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT 1
  `;
  const newest = rows[0];
  const found = verificationItem(
    userId,
    newest ? { id: newest.id, status: newest.status, expires_at: newest.expires_at } : null,
    now,
    newest?.live ?? false,
  );
  return workItemsOutputSchema.parse({ items: found ? [found] : [] });
}

type Principal = { userId: string; kid?: string | null; sub_account?: string | null };

/** `workItems.list` (WORK_ITEMS_PROCEDURE) for the signed person. An API key or a sub-account has no Home of its own. */
export function createWorkItemsRouter(sql: Sql) {
  return router({
    workItems: router({
      list: protectedProcedure.output(workItemsOutputSchema).query(async ({ ctx }) => {
        const principal = ctx.principal as Principal;
        if (principal.kid || principal.sub_account) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Sign in on this device to see what needs you [identity.work_items_delegated]',
          });
        }
        return listVerificationItems(sql, principal.userId);
      }),
    }),
  });
}
