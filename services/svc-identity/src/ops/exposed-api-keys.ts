/**
 * Exposed-key intake (DV-keys-05, keys-012, ENGINE KS-13). Operator only: outside reporters and crawling are an
 * owner decision and are not built.
 *
 * An operator with `admin:write`, a second factor and a live session submits a key string someone found exposed.
 * svc-identity looks it up by hash (only `ifc_`-prefixed strings can be keys), and in ONE transaction revokes a live
 * match, writes the operator revoke audit row (`api_key_operator_revocations`, reason `reported_exposed`, the DV-keys-04
 * table) and writes the report row. The reply is the same for a match, a miss and an already-revoked key, so the
 * intake cannot be used to test whether a string is a live key. A repeat with the same clientRequestId returns the
 * stored report. After commit the owner notice event is published from the report row; a failed publish leaves
 * `published_at` null and the next report (or `drainExposureNotices`) retries it on the same report id. The revoke is
 * never undone automatically.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { Context } from '@intafaced/contracts';
import type { EventBus } from '@intafaced/events';
import { hashToken } from '../auth/passwords.js';
import { IDENTITY_CLIENT_REQUEST_ID_UNSET } from './operator-sessions.js';
import { OperatorApiKeyError } from './operator-api-keys.js';

export const EXPOSED_KEY_REASON = 'reported_exposed' as const;
export const API_KEY_PREFIX = 'ifc_' as const;

/** The only reply the intake gives. It never says whether the string matched. */
export type ExposureReportReply = { readonly reportId: string; readonly received: true; readonly reportedAt: string };

function requireOperator(context: Context): { userId: string; sessionId: string } {
  const principal = context.principal;
  if (!principal || context.service !== null || principal.kid || principal.sub_account || !principal.scopes.includes('admin:write')) {
    throw new OperatorApiKeyError('admin:write is required', 'operator.denied');
  }
  if (principal.mfa !== true) throw new OperatorApiKeyError('A second factor is required', 'mfa.required');
  return { userId: principal.userId.toLowerCase(), sessionId: principal.sid };
}

export async function reportExposedApiKey(
  sql: Sql,
  bus: Pick<EventBus, 'publish'>,
  context: Context,
  input: { key: string; clientRequestId: string },
): Promise<ExposureReportReply> {
  const actor = requireOperator(context);
  const clientRequestId = input.clientRequestId.trim();
  if (clientRequestId.length < 1 || clientRequestId.length > 128) {
    throw new OperatorApiKeyError(`clientRequestId is unset (${IDENTITY_CLIENT_REQUEST_ID_UNSET})`, IDENTITY_CLIENT_REQUEST_ID_UNSET);
  }
  const candidate = input.key.trim();
  const reply = await transaction(sql, async (tx) => {
    const [session] = await tx<Array<{ revoked: boolean; mfa: boolean; expires_at: Date }>>`
      SELECT revoked, mfa, expires_at FROM sessions WHERE id = ${actor.sessionId} AND user_id = ${actor.userId} FOR UPDATE
    `;
    if (!session || session.revoked || session.expires_at.getTime() <= Date.now()) {
      throw new OperatorApiKeyError('admin:write is required', 'operator.denied');
    }
    if (!session.mfa) throw new OperatorApiKeyError('A second factor is required', 'mfa.required');
    const [stored] = await tx<Array<{ id: string; reported_at: Date }>>`
      SELECT id, reported_at FROM api_key_exposure_reports WHERE client_request_id = ${clientRequestId}
    `;
    if (stored) return { reportId: stored.id, received: true as const, reportedAt: stored.reported_at.toISOString() };
    let keyId: string | null = null;
    let userId: string | null = null;
    if (candidate.startsWith(API_KEY_PREFIX)) {
      const [key] = await tx<Array<{ id: string; user_id: string }>>`
        SELECT id, user_id FROM api_keys WHERE key_hash = ${hashToken(candidate)} AND revoked = false FOR UPDATE
      `;
      if (key) {
        keyId = key.id;
        userId = key.user_id;
        await tx`UPDATE api_keys SET revoked = true WHERE id = ${key.id}`;
        await tx`
          INSERT INTO api_key_operator_revocations (key_id, user_id, actor_id, reason, client_request_id)
          VALUES (${key.id}, ${key.user_id}, ${actor.userId}, ${EXPOSED_KEY_REASON}, ${clientRequestId})
          ON CONFLICT (key_id) DO NOTHING
        `;
      }
    }
    const [row] = await tx<Array<{ id: string; reported_at: Date }>>`
      INSERT INTO api_key_exposure_reports (actor_id, client_request_id, key_id, user_id)
      VALUES (${actor.userId}, ${clientRequestId}, ${keyId}, ${userId})
      RETURNING id, reported_at
    `;
    return { reportId: row!.id, received: true as const, reportedAt: row!.reported_at.toISOString() };
  });
  await drainExposureNotices(sql, bus);
  return reply;
}

/**
 * Publishes every owed owner notice, oldest first, and marks each one published. A publish that throws stops the
 * drain and leaves that row (and later ones) owed; the next drain retries on the same report id.
 */
export async function drainExposureNotices(sql: Sql, bus: Pick<EventBus, 'publish'>, limit = 50): Promise<number> {
  const owed = await sql<Array<{ id: string; key_id: string; user_id: string; reported_at: Date }>>`
    SELECT id, key_id, user_id, reported_at FROM api_key_exposure_reports
    WHERE key_id IS NOT NULL AND user_id IS NOT NULL AND published_at IS NULL
    ORDER BY reported_at LIMIT ${limit}
  `;
  let published = 0;
  for (const row of owed) {
    try {
      await bus.publish(
        'apiKeyExposureCreated',
        { reportId: row.id, keyId: row.key_id, userId: row.user_id, reportedAt: row.reported_at.toISOString() },
        { idempotencyKey: `identity.api_key_exposure:${row.id}` },
      );
    } catch {
      break;
    }
    await sql`UPDATE api_key_exposure_reports SET published_at = clock_timestamp() WHERE id = ${row.id} AND published_at IS NULL`;
    published += 1;
  }
  return published;
}
