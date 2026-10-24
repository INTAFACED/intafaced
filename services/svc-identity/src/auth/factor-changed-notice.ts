/**
 * A notice for each change to a sign-in factor (I-signin-sessions-08; J-identity-05 #6): the authenticator app turned
 * on, off or replaced, a passkey added or removed. The caller queues it inside the transaction that makes the change,
 * so a rolled-back change leaves nothing and a crash after the commit still sends it. Two rows go in:
 *
 * - a "factor-changed" mail to the account's proved address (none without one), saying what changed and that Support can
 *   help if it was not the owner. Like the password-changed notice it is never withdrawn by a later freeze or address
 *   change, and a failed send is tried again (SECURITY_NOTICES in password-reset.ts);
 * - a `security_factor_events` row, which `relaySecurityFactorEvents` publishes as `securityFactorChanged` after the
 *   commit, at least once, for the inbox notice svc-notify writes.
 *
 * The business key is the account and the change's number for that account, counted under the users row lock, so a
 * retried transaction queues nothing twice and two changes never share a key. Neither row carries a secret, a code or
 * a credential id.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { EventBus, SECURITY_FACTOR_CHANGES } from '@intafaced/events';

export type FactorChange = (typeof SECURITY_FACTOR_CHANGES)[number];

export async function queueFactorChangedNotice(
  tx: Sql | TransactionSql,
  input: { userId: string; change: FactorChange; now: Date },
): Promise<string> {
  // Callers already hold this lock; taking it again is free and keeps the count below race-free for any caller.
  const [user] = await tx<Array<{ email: string | null; email_verified_at: Date | null }>>`
    SELECT email, email_verified_at FROM users WHERE id = ${input.userId} FOR UPDATE
  `;
  const [prior] = await tx<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM security_factor_events WHERE user_id = ${input.userId}
  `;
  const key = `factor-changed:${input.userId}:${(prior?.n ?? 0) + 1}`;
  await tx`
    INSERT INTO security_factor_events (user_id, notice_key, change, changed_at)
    VALUES (${input.userId}, ${key}, ${input.change}, ${input.now})
    ON CONFLICT (notice_key) DO NOTHING
  `;
  if (user?.email && user.email_verified_at) {
    await tx`
      INSERT INTO mail_outbox (flow_id, user_id, dedupe_key, body_hash, purpose, recipient, code, detail, expires_at, status, created_at)
      VALUES (
        NULL, ${input.userId}, ${key}, ${createHash('sha256').update(key).digest('hex')}, 'factor-changed',
        ${user.email}, NULL, ${input.change}, ${input.now}, 'pending', ${input.now}
      )
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    `;
  }
  return key;
}

export interface SecurityFactorRelayDeps {
  readonly sql: Sql;
  readonly bus: Pick<EventBus, 'publish'>;
  readonly now: () => Date;
}

/**
 * Publish the factor changes not yet published, oldest first. Each row is claimed under SKIP LOCKED and marked only
 * after its publish returns, so a crash in between publishes it again with the same business key (the consumer
 * dedupes on it) and never loses it. A publish that throws leaves its row, and every row after it, for the next run.
 */
export async function relaySecurityFactorEvents(deps: SecurityFactorRelayDeps, limit = 50): Promise<number> {
  return deps.sql.begin(async (tx) => {
    const due = await tx<Array<{ id: string; user_id: string; notice_key: string; change: FactorChange; changed_at: Date }>>`
      SELECT id, user_id, notice_key, change, changed_at FROM security_factor_events
      WHERE published_at IS NULL ORDER BY created_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
    `;
    let published = 0;
    for (const row of due) {
      await deps.bus.publish(
        'securityFactorChanged',
        {
          userId: row.user_id,
          change: row.change,
          changedAt: new Date(row.changed_at).toISOString(),
          noticeKey: row.notice_key,
        },
        { idempotencyKey: row.notice_key },
      );
      await tx`UPDATE security_factor_events SET published_at = ${deps.now()} WHERE id = ${row.id}`;
      published += 1;
    }
    return published;
  });
}
