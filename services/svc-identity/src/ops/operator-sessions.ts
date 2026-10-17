/**
 * Operator session read and revoke. The list never returns a token, a hash,
 * or an address. Revoke consumes an identity.revoke_sessions approval in the
 * same transaction and touches sessions only.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import type { Context } from '@intafaced/contracts';
import { sqlCasConsume, sqlGetApprovalForUpdate } from '../auth/action-approval-store.js';

export const REVOKE_SESSIONS_ACTION = 'identity.revoke_sessions';
export const REVOKE_SESSIONS_SERVICE = 'svc-identity';
export const REVOKE_SESSIONS_VERSION = '1';

export const IDENTITY_CLIENT_REQUEST_ID_UNSET = 'identity.client_request_id_unset' as const;
export const IDENTITY_REVOKE_APPROVAL_REQUIRED = 'identity.revoke_approval_required' as const;
export const IDENTITY_REVOKE_IDEMPOTENCY_CONFLICT = 'identity.revoke_idempotency_conflict' as const;

export class OperatorSessionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'operator.denied'
      | 'mfa.required'
      | typeof IDENTITY_CLIENT_REQUEST_ID_UNSET
      | typeof IDENTITY_REVOKE_APPROVAL_REQUIRED
      | typeof IDENTITY_REVOKE_IDEMPOTENCY_CONFLICT,
  ) {
    super(message);
    this.name = 'OperatorSessionError';
  }
}

export type OperatorSessionRow = {
  readonly deviceLabel: string | null;
  readonly created: string;
  readonly lastSeen: string;
  readonly state: 'live' | 'revoked' | 'expired';
};

export type RevokeSessionsResult = {
  readonly userId: string;
  readonly revokedSessionCount: number;
  readonly approvalId: string;
  readonly clientRequestId: string;
};

/** Bound to the user id. expectedVersion is the fixed `1` this door consumes. */
export function revokeSessionsPayloadHash(userId: string): string {
  return founderChangeHash({ userId: userId.toLowerCase() }, REVOKE_SESSIONS_VERSION);
}

function requireOperator(context: Context, scope: 'admin:compliance' | 'admin:write', mfa: boolean): { userId: string; sessionId: string } {
  const principal = context.principal;
  if (!principal || context.service !== null || principal.kid || principal.sub_account || !principal.scopes.includes(scope)) {
    throw new OperatorSessionError(`${scope} is required`, 'operator.denied');
  }
  if (mfa && principal.mfa !== true) throw new OperatorSessionError('A second factor is required', 'mfa.required');
  return { userId: principal.userId.toLowerCase(), sessionId: principal.sid };
}

function queryHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function listSessionsForUser(sql: Sql, context: Context, userId: string): Promise<{ sessions: OperatorSessionRow[] }> {
  const actor = requireOperator(context, 'admin:compliance', false);
  const named = userId.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(named)) {
    throw new OperatorSessionError('userId is required', 'operator.denied');
  }
  const now = new Date();
  const rows = await sql<Array<{ device: string | null; created_at: Date; last_used_at: Date; revoked: boolean; expires_at: Date }>>`
    SELECT device, created_at, last_used_at, revoked, expires_at
    FROM sessions
    WHERE user_id = ${named}
    ORDER BY created_at DESC, id DESC
  `;
  await sql`
    INSERT INTO operator_read_audit (audit_id, actor_id, kind, query_hash)
    VALUES (${randomUUID()}, ${actor.userId}, 'session_list', ${queryHash(named)})
  `;
  return {
    sessions: rows.map((row) => ({
      deviceLabel: row.device,
      created: row.created_at.toISOString(),
      lastSeen: row.last_used_at.toISOString(),
      state: row.revoked ? 'revoked' : row.expires_at.getTime() <= now.getTime() ? 'expired' : 'live',
    })),
  };
}

function fingerprint(userId: string, approvalId: string, clientRequestId: string): string {
  return queryHash(`${userId}\0${approvalId}\0${clientRequestId}`);
}

export async function revokeSessionsForUser(
  sql: Sql,
  context: Context,
  input: { userId: string; approvalId: string; clientRequestId: string },
): Promise<RevokeSessionsResult> {
  const actor = requireOperator(context, 'admin:write', true);
  const userId = input.userId.trim().toLowerCase();
  const approvalId = input.approvalId.trim();
  const clientRequestId = input.clientRequestId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(userId)) {
    throw new OperatorSessionError('userId is required', 'operator.denied');
  }
  if (approvalId.length < 1 || approvalId.length > 128) {
    throw new OperatorSessionError(
      `An identity.revoke_sessions approval is required (${IDENTITY_REVOKE_APPROVAL_REQUIRED})`,
      IDENTITY_REVOKE_APPROVAL_REQUIRED,
    );
  }
  if (clientRequestId.length < 1 || clientRequestId.length > 128) {
    throw new OperatorSessionError(`clientRequestId is unset (${IDENTITY_CLIENT_REQUEST_ID_UNSET})`, IDENTITY_CLIENT_REQUEST_ID_UNSET);
  }
  const hash = fingerprint(userId, approvalId, clientRequestId);
  const payloadHash = revokeSessionsPayloadHash(userId);
  return transaction(sql, async (tx) => {
    const [session] = await tx<Array<{ revoked: boolean; mfa: boolean; expires_at: Date }>>`
      SELECT revoked, mfa, expires_at FROM sessions WHERE id = ${actor.sessionId} AND user_id = ${actor.userId} FOR UPDATE
    `;
    if (!session || session.revoked || session.expires_at.getTime() <= Date.now()) {
      throw new OperatorSessionError('admin:write is required', 'operator.denied');
    }
    if (!session.mfa) throw new OperatorSessionError('A second factor is required', 'mfa.required');
    const [prior] = await tx<Array<{ fingerprint: string; result: RevokeSessionsResult }>>`
      SELECT fingerprint, result FROM session_revoke_receipts
      WHERE actor_id = ${actor.userId} AND client_request_id = ${clientRequestId}
      FOR UPDATE
    `;
    if (prior) {
      if (prior.fingerprint !== hash) {
        throw new OperatorSessionError(
          `This client id was already used for a different revoke (${IDENTITY_REVOKE_IDEMPOTENCY_CONFLICT})`,
          IDENTITY_REVOKE_IDEMPOTENCY_CONFLICT,
        );
      }
      return prior.result;
    }
    const approval = await sqlGetApprovalForUpdate(tx, approvalId);
    const bound =
      approval !== null &&
      approval.status === 'APPROVED' &&
      approval.actionType === REVOKE_SESSIONS_ACTION &&
      approval.targetService === REVOKE_SESSIONS_SERVICE &&
      approval.targetId.toLowerCase() === userId &&
      approval.expectedVersion === REVOKE_SESSIONS_VERSION &&
      approval.payloadHash === payloadHash &&
      approval.approverId !== null &&
      approval.approverId !== approval.requesterId &&
      approval.expiresAt.getTime() > Date.now();
    if (!bound || approval === null) {
      throw new OperatorSessionError(
        `An identity.revoke_sessions approval bound to this account is required (${IDENTITY_REVOKE_APPROVAL_REQUIRED})`,
        IDENTITY_REVOKE_APPROVAL_REQUIRED,
      );
    }
    const consumed = await sqlCasConsume(tx, {
      approvalId: approval.approvalId,
      operationId: approval.operationId,
      payloadHash: approval.payloadHash,
      targetService: approval.targetService,
      targetId: approval.targetId,
      expectedVersion: approval.expectedVersion,
      now: new Date(),
      requestId: clientRequestId,
      consumedByService: REVOKE_SESSIONS_SERVICE,
      consumedByPrincipal: actor.userId,
    });
    if (!consumed) {
      throw new OperatorSessionError(
        `An identity.revoke_sessions approval bound to this account is required (${IDENTITY_REVOKE_APPROVAL_REQUIRED})`,
        IDENTITY_REVOKE_APPROVAL_REQUIRED,
      );
    }
    const revoked = await tx<Array<{ id: string }>>`
      UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false RETURNING id
    `;
    const result: RevokeSessionsResult = {
      userId,
      revokedSessionCount: revoked.length,
      approvalId,
      clientRequestId,
    };
    await tx`
      INSERT INTO session_revoke_receipts (actor_id, client_request_id, fingerprint, result)
      VALUES (${actor.userId}, ${clientRequestId}, ${hash}, ${tx.json(result as never)})
    `;
    return result;
  });
}
