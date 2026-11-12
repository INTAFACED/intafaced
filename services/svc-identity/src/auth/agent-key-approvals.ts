/**
 * Agent keys and money (J-developer-15 #6): a payout or a refund an agent key attempts is refused `auth.scope_denied`
 * and no approval row is made. The edge stops the request before it reaches the service and asks here; identity checks
 * the key is the user's live key and says whether it is an agent key. Nothing is written.
 *
 * `listAgentKeyApprovals` still reads rows written before this rule, for the owner's record; no new row is written.
 */
import type { Sql } from 'postgres';
import { AGENT_KEY_ACTION_REFUSAL } from '@intafaced/contracts/api-keys';
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

export async function holdAgentKeyAction(sql: Sql, input: AgentKeyHoldInput): Promise<AgentKeyHoldOutput> {
  const keys = await sql<Array<{ kind: string }>>`
    SELECT kind FROM api_keys WHERE id = ${input.keyId} AND user_id = ${input.userId} AND revoked = false
  `;
  const key = keys[0];
  // The edge opened this key a moment ago; a key that is not the user's live key now is not let through either way.
  if (!key) throw new AgentKeyApprovalError('API key not found', 'identity.key_not_found');
  if (key.kind !== 'agent') return { held: false };
  // An agent key cannot move money (J-developer-15 #6): refused, and no approval row is made.
  return { held: true, refusal: AGENT_KEY_ACTION_REFUSAL };
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
