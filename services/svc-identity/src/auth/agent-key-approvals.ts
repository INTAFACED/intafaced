/**
 * Agent-key approvals (DV-keys-05, J-developer-15 #6): a sensitive action an agent key attempts is held, not run. The
 * edge stops the request before it reaches the service and asks here; identity checks the key is the user's live agent
 * key and writes one waiting row the owner sees on the key page. A key that is not an agent key is not held.
 *
 * The row's business key is the key, the action and the request body's hash, so the same attempt retried reads back
 * the same row (`ON CONFLICT DO NOTHING`, then read).
 */
import type { Sql } from 'postgres';
import type { AgentKeyApproval, AgentKeyHoldInput, AgentKeyHoldOutput, AgentHeldAction } from '@intafaced/contracts/api-keys';

export class AgentKeyApprovalError extends Error {
  constructor(
    message: string,
    readonly code: 'identity.key_not_found',
  ) {
    super(message);
    this.name = 'AgentKeyApprovalError';
  }
}

type Row = {
  id: string;
  key_id: string;
  key_name: string;
  action: string;
  method: string;
  path: string;
  status: string;
  created_at: Date;
};

function toApproval(row: Row): AgentKeyApproval {
  return {
    id: row.id,
    keyId: row.key_id,
    keyName: row.key_name,
    action: row.action as AgentHeldAction,
    method: row.method,
    path: row.path,
    status: 'waiting',
    createdAt: row.created_at.toISOString(),
  };
}

export function agentApprovalIdempotencyKey(input: Pick<AgentKeyHoldInput, 'keyId' | 'action' | 'bodyHash'>): string {
  return `agent-approval:${input.keyId.toLowerCase()}:${input.action}:${input.bodyHash}`;
}

export async function holdAgentKeyAction(sql: Sql, input: AgentKeyHoldInput): Promise<AgentKeyHoldOutput> {
  const keys = await sql<Array<{ kind: string; name: string }>>`
    SELECT kind, name FROM api_keys WHERE id = ${input.keyId} AND user_id = ${input.userId} AND revoked = false
  `;
  const key = keys[0];
  // The edge opened this key a moment ago; a key that is not the user's live key now is not let through either way.
  if (!key) throw new AgentKeyApprovalError('API key not found', 'identity.key_not_found');
  if (key.kind !== 'agent') return { held: false };
  const idempotencyKey = agentApprovalIdempotencyKey(input);
  await sql`
    INSERT INTO agent_key_approvals (idempotency_key, user_id, key_id, action, method, path, body_hash)
    VALUES (${idempotencyKey}, ${input.userId}, ${input.keyId}, ${input.action}, ${input.method.toUpperCase()}, ${input.path}, ${input.bodyHash})
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
  const rows = await sql<Row[]>`
    SELECT a.id, a.key_id, k.name AS key_name, a.action, a.method, a.path, a.status, a.created_at
    FROM agent_key_approvals a JOIN api_keys k ON k.id = a.key_id
    WHERE a.idempotency_key = ${idempotencyKey} AND a.user_id = ${input.userId}
  `;
  const row = rows[0];
  if (!row) throw new AgentKeyApprovalError('API key not found', 'identity.key_not_found');
  return { held: true, approval: toApproval(row) };
}

/** The owner's held agent attempts, newest first. */
export async function listAgentKeyApprovals(sql: Sql, userId: string, limit: number): Promise<{ approvals: AgentKeyApproval[] }> {
  const rows = await sql<Row[]>`
    SELECT a.id, a.key_id, k.name AS key_name, a.action, a.method, a.path, a.status, a.created_at
    FROM agent_key_approvals a JOIN api_keys k ON k.id = a.key_id
    WHERE a.user_id = ${userId}
    ORDER BY a.created_at DESC, a.id
    LIMIT ${limit}
  `;
  return { approvals: rows.map(toApproval) };
}
