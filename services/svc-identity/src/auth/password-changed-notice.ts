/**
 * "Your password was changed" (I-signin-sessions-08; J-identity-03 #6). Every change and every reset queues one notice
 * to the account's own proved address, in the same transaction as the new hash, so a crash after the commit still sends
 * it and a rolled-back change sends nothing. The notice carries no code and no link: it says what happened and that
 * Support can help if it was not the owner.
 *
 * The business key is the account and the change's number for that account, counted under the users row lock both
 * callers hold, so a retried transaction queues nothing twice and two changes never share a key. An
 * account with no proved address gets no notice. The notice goes to the address that was proved when the change
 * happened, even if the address changes or the account is frozen before it leaves: that is when its owner most needs
 * it. It carries no secret, so a send that may have failed is tried again, on a doubling wait for about two hours, before
 * it is given up (see the relay).
 *
 * The change is also a sign-in factor change for the inbox (J-identity-03 #6): one `security_factor_events` row,
 * `password_changed`, which the relay publishes for svc-notify. It is queued with `mail: false`, since this notice is the
 * mail, and it goes even when the account has no proved address, because the inbox needs none.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { queueFactorChangedNotice } from './factor-changed-notice.js';

export async function queuePasswordChangedNotice(tx: Sql | TransactionSql, input: { userId: string; now: Date }): Promise<boolean> {
  await queueFactorChangedNotice(tx, { userId: input.userId, change: 'password_changed', now: input.now, mail: false });
  const [user] = await tx<Array<{ email: string | null; email_verified_at: Date | null }>>`
    SELECT email, email_verified_at FROM users WHERE id = ${input.userId}
  `;
  if (!user?.email || !user.email_verified_at) return false;
  // Both callers hold the users row FOR UPDATE, so this count cannot race another change of the same account.
  const [prior] = await tx<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM mail_outbox WHERE user_id = ${input.userId} AND purpose = 'password-changed'
  `;
  const key = `password-changed:${input.userId}:${(prior?.n ?? 0) + 1}`;
  const rows = await tx<Array<{ id: string }>>`
    INSERT INTO mail_outbox (flow_id, user_id, dedupe_key, body_hash, purpose, recipient, code, expires_at, status, created_at)
    VALUES (
      NULL, ${input.userId}, ${key}, ${createHash('sha256').update(key).digest('hex')}, 'password-changed',
      ${user.email}, NULL, ${input.now}, 'pending', ${input.now}
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}
