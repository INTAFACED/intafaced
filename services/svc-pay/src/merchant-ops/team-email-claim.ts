/**
 * Bind pending email invites to the confirmed account.
 *
 * Called by svc-identity over service HMAC, not by a merchant session.
 * Identity only calls this after `email_verified_at` is set, and sends the
 * stored mailbox. A missing published lifetime binds nothing. An invite
 * older than that lifetime stays pending.
 *
 * A claim only binds: `user_id` becomes the account and status stays
 * `invited`. The person sees it in myInvitations and accepts with
 * acceptInvite, which is the only way an invitation becomes access.
 * The merchant list keeps the email token (stashed on the label) until then.
 *
 * A `removed` row is never revived. Someone who declined or left is not
 * put back by a later invite. A fresh invited row with that account id is
 * impossible while the removed row holds `(merchant_id, user_id)`, so the
 * claim skips and the email invite stays pending.
 *
 * Lock order matches `TeamService.invite`: merchant row first, then member
 * rows. Claim never holds a member lock while waiting for a merchant lock.
 */
import type { Sql, TransactionSql } from 'postgres';
import { MerchantOpsError } from './errors.js';
import { emailInviteToken, normaliseTeamInviteEmail, publishedTeamEmailInviteTtlMs, stashInviteEmail } from './team-email.js';

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EmailInviteClaimResult {
  readonly claimed: number;
  /** Always zero. A claim does not grant access. */
  readonly accepted: number;
}

interface PendingRow {
  id: string;
  merchant_id: string;
  label: string | null;
}

export async function claimEmailTeamInvites(
  sql: Sql,
  input: { userId: string; email: string },
  ttlMs: number | undefined,
): Promise<EmailInviteClaimResult> {
  const email = normaliseTeamInviteEmail(input.email);
  const userId = input.userId.trim();
  if (!email || !USER_ID.test(userId)) throw new MerchantOpsError('pay.team_email_invalid', 'bad_request');
  const ttl = publishedTeamEmailInviteTtlMs(ttlMs);
  if (ttl === undefined) return { claimed: 0, accepted: 0 };
  const token = emailInviteToken(email);

  return sql.begin(async (tx) => {
    const preview = await tx<Array<{ merchant_id: string }>>`
      SELECT merchant_id FROM pay.merchant_team_members
       WHERE user_id = ${token} AND status = 'invited'
         AND updated_at >= now() - (${ttl} * interval '1 millisecond')`;
    const merchantIds = [...new Set(preview.map((row) => row.merchant_id))].sort();
    for (const merchantId of merchantIds) {
      await tx`SELECT id FROM pay.merchants WHERE id = ${merchantId} FOR UPDATE`;
    }
    const pending = await tx<PendingRow[]>`
      SELECT id, merchant_id, label
        FROM pay.merchant_team_members
       WHERE user_id = ${token} AND status = 'invited'
         AND updated_at >= now() - (${ttl} * interval '1 millisecond')
       ORDER BY id
       FOR UPDATE`;
    let claimed = 0;
    for (const row of pending) {
      if (await bindOne(tx, row, userId, token)) claimed += 1;
    }
    return { claimed, accepted: 0 };
  });
}

/**
 * True when this invite is now bound to the account and still invited.
 * False leaves the email row untouched.
 */
async function bindOne(tx: TransactionSql, row: PendingRow, userId: string, token: string): Promise<boolean> {
  const existing = await tx<Array<{ id: string; status: string }>>`
    SELECT id, status FROM pay.merchant_team_members
     WHERE merchant_id = ${row.merchant_id} AND user_id = ${userId}
     FOR UPDATE`;
  // Active, invited, or removed: do not take over that row. A removed row
  // cannot be revived, and a second row with the same account id does not fit.
  if (existing[0]) return false;
  const updated = await tx<Array<{ id: string }>>`
    UPDATE pay.merchant_team_members
       SET user_id = ${userId}, label = ${stashInviteEmail(row.label, token)}, updated_at = now()
     WHERE id = ${row.id} AND status = 'invited' AND user_id = ${token}
     RETURNING id`;
  return Boolean(updated[0]);
}
