import type { Sql } from 'postgres';
import type { EventBus } from '@intafaced/events';

/** The business key of a request's notice: one per request, however often it is published. */
export const approvalNoticeKey = (requestId: string): string => `agents.approval.requested:${requestId}`;

type Scope = {
  /** Only this person's requests. */
  readonly ownerId?: string;
  /** Only this request (the one a call just held), so a call never waits on a backlog the sweep owns. */
  readonly requestId?: string;
  /** Told of each request that could not be published; it stays unpublished and the next sweep tries again. */
  readonly onError?: (err: unknown, requestId: string) => void;
};

/**
 * Publishes every held tool call not yet announced (AG-approvals-01, J-agents-05 #4), each on its request's business
 * key, then marks it published. Each request is published under its row lock, read again under that lock: a decision
 * (approve, reject, edit) or an expiry sweep waits for it, so a request that stopped waiting is never announced, only
 * marked, as there is nothing left for the person to approve. A crash between the publish and the mark publishes it
 * again on the next sweep under the same key: JetStream drops it inside its duplicate window, and past that the
 * consumer writes one row per key (svc-notify dedupes on the subject and key). One request that cannot be published
 * never holds back the rest. Returns how many were published.
 */
export async function publishPendingApprovalRequests(sql: Sql, bus: EventBus, scope: Scope = {}): Promise<number> {
  const pending = await sql<Array<{ id: string }>>`
    SELECT id::text AS id FROM agents.own_agent_approval_requests
     WHERE published_at IS NULL
       ${scope.ownerId === undefined ? sql`` : sql`AND owner_id = ${scope.ownerId}`}
       ${scope.requestId === undefined ? sql`` : sql`AND id = ${scope.requestId}`}
     ORDER BY created_at
     LIMIT 100
  `;
  let published = 0;
  for (const { id } of pending) {
    try {
      const sent = await sql.begin(async (tx) => {
        const rows = await tx<
          Array<{ owner_id: string; agent_id: string; session_id: string; tool: string; expires_at: Date; waiting: boolean }>
        >`
          SELECT owner_id, agent_id::text AS agent_id, session_id::text AS session_id, tool, expires_at,
                 (status = 'waiting' AND expires_at > now()) AS waiting
            FROM agents.own_agent_approval_requests
           WHERE id = ${id} AND published_at IS NULL
           FOR UPDATE SKIP LOCKED
        `;
        const row = rows[0];
        // Published meanwhile, or another sweep holds it.
        if (!row) return false;
        if (row.waiting) {
          await bus.publish(
            'agentApprovalRequested',
            {
              requestId: id,
              userId: row.owner_id,
              agentId: row.agent_id,
              sessionId: row.session_id,
              tool: row.tool,
              expiresAt: row.expires_at.toISOString(),
            },
            { idempotencyKey: approvalNoticeKey(id) },
          );
        }
        await tx`UPDATE agents.own_agent_approval_requests SET published_at = now() WHERE id = ${id}`;
        return row.waiting;
      });
      if (sent) published += 1;
    } catch (err) {
      scope.onError?.(err, id);
    }
  }
  return published;
}
