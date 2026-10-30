/**
 * Operator revoke of one customer API key (DV-keys-04, ENGINE KS-11).
 *
 * A support agent or founder-ops operator with `admin:write`, a second factor and a live session revokes one key of
 * one account and must give a reason. The first revoke flips `api_keys.revoked` and writes one audit row with the
 * actor and the reason in the same transaction; the key stops verifying at once (`verifyApiKey` reads
 * `revoked = false`). A repeat on the same key is a no-op that returns the stored row. The operator never sees a
 * secret, a hash or a prefix. Whole-account freeze stays with `compliance.freezeIdentity`; the ledger posting freeze
 * is not touched here.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { Context } from '@intafaced/contracts';
import { IDENTITY_CLIENT_REQUEST_ID_UNSET } from './operator-sessions.js';

export const IDENTITY_REVOKE_REASON_UNSET = 'identity.revoke_reason_unset' as const;

export type OperatorApiKeyErrorCode =
  'operator.denied' | 'mfa.required' | 'auth.not_found' | typeof IDENTITY_REVOKE_REASON_UNSET | typeof IDENTITY_CLIENT_REQUEST_ID_UNSET;

export class OperatorApiKeyError extends Error {
  constructor(
    message: string,
    readonly code: OperatorApiKeyErrorCode,
  ) {
    super(message);
    this.name = 'OperatorApiKeyError';
  }
}

export type OperatorRevokeKeyResult = {
  readonly userId: string;
  readonly keyId: string;
  /** True only for the call that revoked the key. */
  readonly changed: boolean;
  /** The operator revoke on record, or null when the key was already revoked another way (owner, freeze, expiry). */
  readonly revocation: { readonly actorId: string; readonly reason: string; readonly revokedAt: string } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireOperator(context: Context): { userId: string; sessionId: string } {
  const principal = context.principal;
  if (!principal || context.service !== null || principal.kid || principal.sub_account || !principal.scopes.includes('admin:write')) {
    throw new OperatorApiKeyError('admin:write is required', 'operator.denied');
  }
  if (principal.mfa !== true) throw new OperatorApiKeyError('A second factor is required', 'mfa.required');
  return { userId: principal.userId.toLowerCase(), sessionId: principal.sid };
}

export async function revokeApiKeyForUser(
  sql: Sql,
  context: Context,
  input: { userId: string; keyId: string; reason: string; clientRequestId: string },
): Promise<OperatorRevokeKeyResult> {
  const actor = requireOperator(context);
  const userId = input.userId.trim().toLowerCase();
  const keyId = input.keyId.trim().toLowerCase();
  const reason = input.reason.trim();
  const clientRequestId = input.clientRequestId.trim();
  if (!UUID.test(userId) || !UUID.test(keyId)) throw new OperatorApiKeyError('API key not found', 'auth.not_found');
  if (reason.length < 1 || reason.length > 500) {
    throw new OperatorApiKeyError(`A reason is required to revoke a key (${IDENTITY_REVOKE_REASON_UNSET})`, IDENTITY_REVOKE_REASON_UNSET);
  }
  if (clientRequestId.length < 1 || clientRequestId.length > 128) {
    throw new OperatorApiKeyError(`clientRequestId is unset (${IDENTITY_CLIENT_REQUEST_ID_UNSET})`, IDENTITY_CLIENT_REQUEST_ID_UNSET);
  }
  return transaction(sql, async (tx) => {
    const [session] = await tx<Array<{ revoked: boolean; mfa: boolean; expires_at: Date }>>`
      SELECT revoked, mfa, expires_at FROM sessions WHERE id = ${actor.sessionId} AND user_id = ${actor.userId} FOR UPDATE
    `;
    if (!session || session.revoked || session.expires_at.getTime() <= Date.now()) {
      throw new OperatorApiKeyError('admin:write is required', 'operator.denied');
    }
    if (!session.mfa) throw new OperatorApiKeyError('A second factor is required', 'mfa.required');
    const [key] = await tx<Array<{ revoked: boolean }>>`
      SELECT revoked FROM api_keys WHERE id = ${keyId} AND user_id = ${userId} FOR UPDATE
    `;
    // Another account's key and a missing key answer the same.
    if (!key) throw new OperatorApiKeyError('API key not found', 'auth.not_found');
    const [prior] = await tx<Array<{ actor_id: string; reason: string; revoked_at: Date }>>`
      SELECT actor_id, reason, revoked_at FROM api_key_operator_revocations WHERE key_id = ${keyId}
    `;
    if (prior) {
      return {
        userId,
        keyId,
        changed: false,
        revocation: { actorId: prior.actor_id, reason: prior.reason, revokedAt: prior.revoked_at.toISOString() },
      };
    }
    if (key.revoked) return { userId, keyId, changed: false, revocation: null };
    await tx`UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'operator' WHERE id = ${keyId} AND user_id = ${userId}`;
    const [row] = await tx<Array<{ revoked_at: Date }>>`
      INSERT INTO api_key_operator_revocations (key_id, user_id, actor_id, reason, client_request_id)
      VALUES (${keyId}, ${userId}, ${actor.userId}, ${reason}, ${clientRequestId})
      RETURNING revoked_at
    `;
    return { userId, keyId, changed: true, revocation: { actorId: actor.userId, reason, revokedAt: row!.revoked_at.toISOString() } };
  });
}
