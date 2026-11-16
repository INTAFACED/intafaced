import type { Sql } from 'postgres';

/**
 * The founder's audit log over the person's outside assistant connections (J-agents-21 #15; agent-desk.ts):
 * `trade.user_venue_agent_desk_audit` (drizzle/20261114090000_user_venue_agent_desk_audit.sql). One row per switch,
 * naming the operator and the reason. A key is quarantined once. Append-only: a row is never changed or deleted.
 */

export interface AgentDeskAuditRecord {
  readonly id: string;
  readonly action: 'quarantine';
  readonly keyId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly operatorId: string;
  readonly reason: string;
  readonly requestId: string;
  readonly at: Date;
}

export interface AgentDeskAuditStore {
  /** Store the key's quarantine unless it has one; returns the stored row and whether this call wrote it. */
  quarantineOnce(row: AgentDeskAuditRecord): Promise<{ readonly row: AgentDeskAuditRecord; readonly created: boolean }>;
  /** The quarantine rows of these keys, by key id. */
  quarantines(keyIds: readonly string[]): Promise<ReadonlyMap<string, AgentDeskAuditRecord>>;
  /** The newest rows, newest first, at most `limit`. */
  list(limit: number): Promise<readonly AgentDeskAuditRecord[]>;
}

export class InMemoryAgentDeskAuditStore implements AgentDeskAuditStore {
  readonly rows: AgentDeskAuditRecord[] = [];

  async quarantineOnce(row: AgentDeskAuditRecord) {
    const existing = this.rows.find((r) => r.action === 'quarantine' && r.keyId === row.keyId);
    if (existing) return { row: existing, created: false };
    this.rows.push(row);
    return { row, created: true };
  }

  async quarantines(keyIds: readonly string[]) {
    const wanted = new Set(keyIds);
    return new Map(this.rows.filter((r) => r.action === 'quarantine' && wanted.has(r.keyId)).map((r) => [r.keyId, r]));
  }

  async list(limit: number) {
    return [...this.rows].sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id)).slice(0, limit);
  }
}

interface Row {
  id: string;
  action: 'quarantine';
  key_id: string;
  user_id: string;
  account_id: string;
  operator_id: string;
  reason: string;
  request_id: string;
  at: Date;
}

const recordOf = (r: Row): AgentDeskAuditRecord => ({
  id: r.id,
  action: r.action,
  keyId: r.key_id,
  userId: r.user_id,
  accountId: r.account_id,
  operatorId: r.operator_id,
  reason: r.reason,
  requestId: r.request_id,
  at: r.at,
});

const COLUMNS = 'id, action, key_id, user_id, account_id, operator_id, reason, request_id, at';

export class SqlAgentDeskAuditStore implements AgentDeskAuditStore {
  constructor(private readonly sql: Sql) {}

  async quarantineOnce(r: AgentDeskAuditRecord) {
    const inserted = await this.sql<{ id: string }[]>`
      INSERT INTO trade.user_venue_agent_desk_audit (id, action, key_id, user_id, account_id, operator_id, reason, request_id, at)
      VALUES (${r.id}, ${r.action}, ${r.keyId}, ${r.userId}, ${r.accountId}, ${r.operatorId}, ${r.reason}, ${r.requestId}, ${r.at})
      ON CONFLICT (key_id) WHERE action = 'quarantine' DO NOTHING
      RETURNING id`;
    const stored = (await this.quarantines([r.keyId])).get(r.keyId);
    if (!stored) throw new Error(`the quarantine of key ${r.keyId} was not stored`);
    return { row: stored, created: inserted.length > 0 };
  }

  async quarantines(keyIds: readonly string[]) {
    if (keyIds.length === 0) return new Map<string, AgentDeskAuditRecord>();
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM trade.user_venue_agent_desk_audit
      WHERE action = 'quarantine' AND key_id = ANY(${keyIds as string[]}::uuid[])`;
    return new Map(rows.map((r) => [r.key_id, recordOf(r)]));
  }

  async list(limit: number) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM trade.user_venue_agent_desk_audit ORDER BY at DESC, id LIMIT ${limit}`;
    return rows.map(recordOf);
  }
}
