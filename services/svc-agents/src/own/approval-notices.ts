import type { Sql } from 'postgres';
import type { EventBus } from '@intafaced/events';

/** The business key of a request's notice: one per request, however often it is published. */
export const approvalNoticeKey = (requestId: string): string => `agents.approval.requested:${requestId}`;

/**
 * Publishes every held tool call not yet announced (AG-approvals-01, J-agents-05 #4), each on its request's business
 * key, then marks it published. A crash between the two publishes it again under the same key, which the bus drops as a
 * duplicate. A request that stopped waiting before it was announced (decided, replaced or past its expiry) is marked
 * without a notice: there is nothing left for the person to approve. One request that cannot be published never holds
 * back the rest; it stays unpublished and the next sweep tries again. Scoped to one person when given.
 */
export async function publishPendingApprovalRequests(sql: Sql, bus: EventBus, ownerId?: string): Promise<number> {
  const rows = await sql<
    Array<{ id: string; owner_id: string; agent_id: string; session_id: string; tool: string; expires_at: Date; waiting: boolean }>
  >`
    SELECT id::text AS id, owner_id, agent_id::text AS agent_id, session_id::text AS session_id, tool, expires_at,
           (status = 'waiting' AND expires_at > now()) AS waiting
      FROM agents.own_agent_approval_requests
     WHERE published_at IS NULL ${ownerId === undefined ? sql`` : sql`AND owner_id = ${ownerId}`}
     ORDER BY created_at
     LIMIT 100
  `;
  let published = 0;
  for (const row of rows) {
    if (row.waiting) {
      try {
        await bus.publish(
          'agentApprovalRequested',
          {
            requestId: row.id,
            userId: row.owner_id,
            agentId: row.agent_id,
            sessionId: row.session_id,
            tool: row.tool,
            expiresAt: row.expires_at.toISOString(),
          },
          { idempotencyKey: approvalNoticeKey(row.id) },
        );
      } catch {
        continue;
      }
      published += 1;
    }
    await sql`
      UPDATE agents.own_agent_approval_requests SET published_at = now()
       WHERE id = ${row.id} AND published_at IS NULL
    `;
  }
  return published;
}
