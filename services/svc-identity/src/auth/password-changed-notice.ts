/**
 * "Your password was changed" (I-signin-sessions-08; J-identity-03 #6). Every change and every reset queues one notice
 * to the account's own proved address, in the same transaction as the new hash, so a crash after the commit still sends
 * it and a rolled-back change sends nothing. The notice carries no code and no link: it says what happened and that
 * Support can help if it was not the owner.
 *
 * The business key is the account and a digest of the new hash (salted, so a new one each change): a retried commit
 * queues nothing twice. An account with no proved address gets no notice; the relay also withholds it if the address
 * changes or the account is frozen before it goes out.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

export async function queuePasswordChangedNotice(
  tx: Sql | TransactionSql,
  input: { userId: string; nextHash: string; now: Date },
): Promise<boolean> {
  const [user] = await tx<Array<{ email: string | null; email_verified_at: Date | null }>>`
    SELECT email, email_verified_at FROM users WHERE id = ${input.userId}
  `;
  if (!user?.email || !user.email_verified_at) return false;
  const digest = createHash('sha256').update(input.nextHash).digest('hex');
  const rows = await tx<Array<{ id: string }>>`
    INSERT INTO mail_outbox (flow_id, user_id, dedupe_key, body_hash, purpose, recipient, code, expires_at, status, created_at)
    VALUES (
      NULL, ${input.userId}, ${`password-changed:${input.userId}:${digest.slice(0, 32)}`}, ${digest}, 'password-changed',
      ${user.email}, NULL, ${input.now}, 'pending', ${input.now}
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}
