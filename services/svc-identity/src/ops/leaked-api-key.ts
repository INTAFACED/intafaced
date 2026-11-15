/**
 * An operator reports a leaked key string (DV-keys-05, J-developer-07 #6): someone found a key where it should not be
 * and handed the string to us. If it is a live key, it is revoked at once (cause `operator`), with one audit row (the
 * operator revoke record, `api_key_operator_revocations`) and one inbox notice to its holder, in one transaction. A second
 * report of the same string changes nothing. Every report gets the same reply, a match or not, so a report never tells
 * the reporter whether a string was a key. The string is hashed and never stored or logged.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { Context } from '@intafaced/contracts';
import { hashToken } from '../auth/passwords.js';
import { queueFactorChangedNotice } from '../auth/factor-changed-notice.js';

export const LEAK_REPORT_REASON = 'A leaked copy of this key was reported' as const;

export class LeakedKeyError extends Error {
  constructor(
    message: string,
    readonly code: 'operator.denied' | 'mfa.required',
  ) {
    super(message);
    this.name = 'LeakedKeyError';
  }
}

/** A compliance operator signed in with a second factor, never a key or a sub-account. */
function requireOperator(context: Context): { userId: string } {
  const principal = context.principal;
  if (!principal || principal.kid || principal.sub_account || !principal.scopes.includes('admin:compliance')) {
    throw new LeakedKeyError('admin:compliance is required', 'operator.denied');
  }
  if (principal.mfa !== true) throw new LeakedKeyError('A second factor is required', 'mfa.required');
  return { userId: principal.userId.toLowerCase() };
}

/** The one reply every report gets. */
export const LEAK_REPORT_RECEIVED = { received: true } as const;

export async function reportLeakedKey(
  sql: Sql,
  context: Context,
  key: string,
  now: Date = new Date(),
): Promise<typeof LEAK_REPORT_RECEIVED> {
  const actor = requireOperator(context);
  const hash = hashToken(key.trim());
  await transaction(sql, async (tx) => {
    const [found] = await tx<Array<{ id: string; user_id: string; revoked: boolean }>>`
      SELECT id, user_id, revoked FROM api_keys WHERE key_hash = ${hash} FOR UPDATE
    `;
    if (!found || found.revoked) return;
    // The holder's row first, as every notice writer locks it; then the key, its audit row and the notice together.
    await tx`SELECT id FROM users WHERE id = ${found.user_id} FOR UPDATE`;
    await tx`UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'operator' WHERE id = ${found.id}`;
    await tx`
      INSERT INTO api_key_operator_revocations (key_id, user_id, actor_id, reason, client_request_id)
      VALUES (${found.id}, ${found.user_id}, ${actor.userId}, ${LEAK_REPORT_REASON}, ${`leak-report:${found.id}`})
      ON CONFLICT (key_id) DO NOTHING
    `;
    await queueFactorChangedNotice(tx, { userId: found.user_id, change: 'api_key_revoked', now, mail: false });
  });
  return LEAK_REPORT_RECEIVED;
}

export type OperatorKeyAuditEntry = { actorId: string; reason: string; revokedAt: string };

/** The operator revoke record of one key: at most one entry. Never a secret, a hash or a prefix. */
export async function operatorKeyAudit(sql: Sql, context: Context, keyId: string): Promise<{ entries: OperatorKeyAuditEntry[] }> {
  requireOperator(context);
  const rows = await sql<Array<{ actor_id: string; reason: string; revoked_at: Date }>>`
    SELECT actor_id, reason, revoked_at FROM api_key_operator_revocations WHERE key_id = ${keyId}
  `;
  return { entries: rows.map((row) => ({ actorId: row.actor_id, reason: row.reason, revokedAt: row.revoked_at.toISOString() })) };
}
