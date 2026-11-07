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
 * And one `new_device` item per still-trusted device with a new-device sign-in the person has not answered: "a new device signed in; if this wasn't
 * you, open Security". It is `action`, links to Security (`/uc/safe`), and its id is `new_device:<the event's notice
 * key>`, the key svc-notify files the inbox notice under, so Home shows that notice here and not twice. It exists while
 * the event is unreviewed and its device is still trusted: "This was me" in Security (`trustedDevices.confirmSignIn`,
 * from another device) or removing the device ends it. Newest first.
 *
 * The owner sends copy keys, never sentences, and links only into its own rooms (`/verification`, `/uc/`).
 */
import { protectedProcedure, router, TRPCError, workItemsOutputSchema, type WorkItem, type WorkItemsOutput } from '@intafaced/contracts';
import type { Sql } from 'postgres';

type NewestRecord = {
  readonly id: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired';
  readonly expires_at: Date | null;
};

const LINK = '/verification';
const SECURITY = '/uc/safe';
/** At most this many new-device items, newest first, inside the contract's limit on one owner's answer. */
const NEW_DEVICE_ITEMS = 20;

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

/** The `new_device` item for one unanswered new-device sign-in, keyed by its notice key. */
export function newDeviceItem(noticeKey: string): WorkItem {
  return {
    id: `new_device:${noticeKey}`,
    kind: 'new_device',
    source: 'identity',
    severity: 'action',
    titleKey: 'identity.new_device.review',
    link: SECURITY,
  };
}

/** The person's still-trusted devices with an unanswered new-device sign-in, one item each, newest first. */
export async function newDeviceItems(sql: Sql, userId: string, now = new Date()): Promise<WorkItem[]> {
  // One item per device: a device approved again before it was answered asks once, by its newest sign-in.
  const rows = await sql<Array<{ notice_key: string }>>`
    SELECT notice_key FROM (
      SELECT DISTINCT ON (e.trusted_device_id) e.notice_key, e.changed_at, e.created_at, e.id
        FROM security_factor_events e JOIN trusted_devices t ON t.id = e.trusted_device_id AND t.user_id = e.user_id
       WHERE e.user_id = ${userId} AND e.change = 'new_device' AND e.reviewed_at IS NULL
         AND t.removed_at IS NULL AND (t.trusted_until IS NULL OR t.trusted_until > ${now})
       ORDER BY e.trusted_device_id, e.changed_at DESC, e.created_at DESC, e.id DESC
    ) newest
     ORDER BY changed_at DESC, created_at DESC, id DESC
     LIMIT ${NEW_DEVICE_ITEMS}
  `;
  return rows.map((row) => newDeviceItem(row.notice_key));
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
        const now = new Date();
        const [verification, devices] = await Promise.all([
          listVerificationItems(sql, principal.userId, now),
          newDeviceItems(sql, principal.userId, now),
        ]);
        return workItemsOutputSchema.parse({ items: [...verification.items, ...devices] });
      }),
    }),
  });
}
