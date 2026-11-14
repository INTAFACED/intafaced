/**
 * A key asks for its own rotation, and a different person approves it (DV-keys-04, J-developer-07 #3).
 *
 * The key's program asks through svc-trade (`POST /api/v1/account/api-key/rotation`), which tells identity, as a
 * service, which key of which account asked. The request waits; the requesting key can never approve it, and no other
 * key can either: only the account's owner, signed in on a device with a fresh passkey, approves it on the key's page,
 * and that approval rotates the key once (`rotateDeveloperKey`) and records the replacement in the same transaction.
 */
import type { ServiceBodyBindMode } from '@intafaced/contracts';
import type { ApiKeyRotateOutput } from '@intafaced/contracts/api-keys';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { PayStepUpFactorProof } from './auth-service.js';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';
import { rotateDeveloperKey } from './developer-key-rotate.js';
import type { Caller, DeveloperKeysDeps } from './developer-keys.js';

export type RotationRequestCode =
  | 'identity.key_not_found'
  | 'identity.key_not_live'
  | 'identity.rotation_request_not_found'
  | 'identity.rotation_self_approval'
  | 'identity.rotation_approver_not_person'
  | 'identity.rotation_key_only';

export class RotationRequestError extends Error {
  constructor(
    message: string,
    readonly code: RotationRequestCode,
  ) {
    super(message);
    this.name = 'RotationRequestError';
  }
}

export type RotationRequest = { requestId: string; keyId: string; overlapSeconds: number; createdAt: string };

/** The key `keyId` of `userId` asks for its rotation. A second ask while one waits answers with the waiting one. */
export async function requestRotation(
  sql: Sql,
  input: { userId: string; keyId: string; overlapSeconds: number },
  now: Date = new Date(),
): Promise<RotationRequest> {
  const [key] = await sql<Array<{ revoked: boolean; expires_at: Date | null }>>`
    SELECT revoked, expires_at FROM api_keys WHERE id = ${input.keyId} AND user_id = ${input.userId}
  `;
  if (!key) throw new RotationRequestError('API key not found', 'identity.key_not_found');
  if (key.revoked || (key.expires_at && key.expires_at.getTime() <= now.getTime())) {
    throw new RotationRequestError('This key is revoked or has ended', 'identity.key_not_live');
  }
  const rows = await sql<Array<{ id: string; key_id: string; overlap_seconds: number; created_at: Date }>>`
    INSERT INTO api_key_rotation_requests (user_id, key_id, overlap_seconds)
    VALUES (${input.userId}, ${input.keyId}, ${input.overlapSeconds})
    ON CONFLICT (key_id) WHERE status = 'waiting' DO NOTHING
    RETURNING id, key_id, overlap_seconds, created_at
  `;
  const row =
    rows[0] ??
    (
      await sql<Array<{ id: string; key_id: string; overlap_seconds: number; created_at: Date }>>`
        SELECT id, key_id, overlap_seconds, created_at FROM api_key_rotation_requests WHERE key_id = ${input.keyId} AND status = 'waiting'
      `
    )[0];
  if (!row) throw new RotationRequestError('API key not found', 'identity.key_not_found');
  return { requestId: row.id, keyId: row.key_id, overlapSeconds: row.overlap_seconds, createdAt: row.created_at.toISOString() };
}

/**
 * A key tries to approve a rotation request. Always refused: the requesting key by name (`rotation_self_approval`), any
 * other key because only a person approves (`rotation_approver_not_person`). A request of another account reads as none.
 */
export async function approveByKey(sql: Sql, input: { userId: string; keyId: string; requestId: string }): Promise<never> {
  const [row] = await sql<Array<{ key_id: string }>>`
    SELECT key_id FROM api_key_rotation_requests WHERE id = ${input.requestId} AND user_id = ${input.userId} AND status = 'waiting'
  `;
  if (!row) throw new RotationRequestError('No waiting rotation request with this id', 'identity.rotation_request_not_found');
  if (row.key_id === input.keyId) {
    throw new RotationRequestError('The key that asked for a rotation cannot approve it', 'identity.rotation_self_approval');
  }
  throw new RotationRequestError(
    'A rotation request is approved by a person signed in on a device',
    'identity.rotation_approver_not_person',
  );
}

/** The waiting request of one of the person's keys, or null. */
export async function waitingRotation(sql: Sql, userId: string, keyId: string): Promise<RotationRequest | null> {
  const [row] = await sql<Array<{ id: string; key_id: string; overlap_seconds: number; created_at: Date }>>`
    SELECT id, key_id, overlap_seconds, created_at FROM api_key_rotation_requests
    WHERE user_id = ${userId} AND key_id = ${keyId} AND status = 'waiting'
  `;
  return row
    ? { requestId: row.id, keyId: row.key_id, overlapSeconds: row.overlap_seconds, createdAt: row.created_at.toISOString() }
    : null;
}

/** The owner approves: one rotation, and the request marked approved in the same transaction. A spent request reads as none. */
export async function approveByPerson(
  deps: DeveloperKeysDeps,
  caller: Caller,
  input: { requestId: string; factorProof?: PayStepUpFactorProof | undefined },
): Promise<ApiKeyRotateOutput> {
  if (caller.kid || caller.sub_account) {
    throw new RotationRequestError(
      'A rotation request is approved by a person signed in on a device',
      'identity.rotation_approver_not_person',
    );
  }
  const [row] = await deps.sql<Array<{ key_id: string; overlap_seconds: number }>>`
    SELECT key_id, overlap_seconds FROM api_key_rotation_requests WHERE id = ${input.requestId} AND user_id = ${caller.userId} AND status = 'waiting'
  `;
  if (!row) throw new RotationRequestError('No waiting rotation request with this id', 'identity.rotation_request_not_found');
  const result = await rotateDeveloperKey(
    deps,
    caller,
    { keyId: row.key_id, overlapSeconds: row.overlap_seconds, factorProof: input.factorProof },
    async (tx, replacementId) => {
      const marked = await tx`
        UPDATE api_key_rotation_requests
        SET status = 'approved', replacement_key_id = ${replacementId}, approved_by = ${caller.userId}, decided_at = now()
        WHERE id = ${input.requestId} AND status = 'waiting'
      `;
      if (marked.count === 0)
        throw new RotationRequestError('No waiting rotation request with this id', 'identity.rotation_request_not_found');
    },
  );
  // The key was already rotated (by its owner directly, or a lost reply): the request is spent by that replacement.
  if (result.replayed) {
    await deps.sql`
      UPDATE api_key_rotation_requests
      SET status = 'approved', replacement_key_id = ${result.record.id}, approved_by = ${caller.userId}, decided_at = now()
      WHERE id = ${input.requestId} AND status = 'waiting'
    `;
  }
  return result;
}

export const ROTATION_REQUEST_PATH = '/internal/api-key-rotation/request';
export const ROTATION_APPROVE_BY_KEY_PATH = '/internal/api-key-rotation/approve-by-key';
/** The one service a key's program reaches identity through for its rotation (svc-trade's REST door). */
const ROTATION_CALLER = 'svc-trade';
const MAX_REQUEST_OVERLAP_SECONDS = 7 * 86_400;

const ROTATION_STATUS: Record<RotationRequestCode, number> = {
  'identity.key_not_found': 404,
  'identity.key_not_live': 409,
  'identity.rotation_request_not_found': 404,
  'identity.rotation_self_approval': 403,
  'identity.rotation_approver_not_person': 403,
  'identity.rotation_key_only': 400,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readBody(body: unknown): { userId: string; keyId: string; requestId?: string; overlapSeconds: number } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.userId !== 'string' || !UUID.test(b.userId) || typeof b.keyId !== 'string' || !UUID.test(b.keyId)) return null;
  if (b.requestId !== undefined && (typeof b.requestId !== 'string' || !UUID.test(b.requestId))) return null;
  const overlap = b.overlapSeconds ?? 0;
  if (typeof overlap !== 'number' || !Number.isInteger(overlap) || overlap < 0 || overlap > MAX_REQUEST_OVERLAP_SECONDS) return null;
  return {
    userId: b.userId,
    keyId: b.keyId,
    ...(typeof b.requestId === 'string' ? { requestId: b.requestId } : {}),
    overlapSeconds: overlap,
  };
}

/**
 * The two doors svc-trade calls for a key's own rotation: ask, and (always refused) approve. The body names the account
 * and the key the edge authenticated; only svc-trade may call them.
 */
export function registerRotationRequestRoutes(
  app: FastifyInstance,
  opts: { sql: Sql; internalSecret: string | undefined; bodyBind?: ServiceBodyBindMode; s2s?: IdentityS2s },
): void {
  const door = (path: string, act: (input: NonNullable<ReturnType<typeof readBody>>) => Promise<unknown>) =>
    app.post(path, async (req, reply) => {
      const { service } = serviceOfRequest(req, opts.internalSecret, opts.bodyBind, opts.s2s);
      if (service === null) return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
      if (service !== ROTATION_CALLER) return reply.code(403).send({ error: 'caller not allowed', code: 'identity.caller_forbidden' });
      const input = readBody(req.body);
      if (!input) return reply.code(400).send({ error: 'invalid rotation request', code: 'identity.rotation_key_only' });
      try {
        return await act(input);
      } catch (error) {
        if (error instanceof RotationRequestError) {
          return reply.code(ROTATION_STATUS[error.code]).send({ error: error.message, code: error.code });
        }
        throw error;
      }
    });
  door(ROTATION_REQUEST_PATH, (input) => requestRotation(opts.sql, input));
  door(ROTATION_APPROVE_BY_KEY_PATH, (input) => {
    if (!input.requestId) throw new RotationRequestError('requestId is required', 'identity.rotation_key_only');
    return approveByKey(opts.sql, { userId: input.userId, keyId: input.keyId, requestId: input.requestId });
  });
}
