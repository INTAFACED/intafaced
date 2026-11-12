import type { Sql } from 'postgres';

/**
 * Which of the person's own agent API keys trades which of their agent accounts (J-agents-21 #6 #7; agent-orders.ts):
 * `trade.user_venue_agent_connections` (drizzle/20261111122333_user_venue_agent_connections.sql).
 *
 * Keyed by identity's key id. A key has at most one connection that has not ended (a unique index in SQL, one map entry
 * here), so an order from a key always names exactly one agent account. A connection is never deleted: it ends.
 */

export interface AgentConnectionRecord {
  readonly keyId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
}

export interface AgentConnectionStore {
  /** The key's connection that has not ended, or `null`. */
  active(keyId: string): Promise<AgentConnectionRecord | null>;
  /** The person's connections that have not ended, oldest first. */
  listActive(userId: string): Promise<readonly AgentConnectionRecord[]>;
  /**
   * Store `record` unless the key already has an active connection; returns the active one (this one, or the one that
   * was there first: the caller compares and refuses a different account).
   */
  connectOnce(record: AgentConnectionRecord): Promise<AgentConnectionRecord>;
}

export class InMemoryAgentConnectionStore implements AgentConnectionStore {
  private readonly rows: AgentConnectionRecord[] = [];

  async active(keyId: string) {
    return this.rows.find((r) => r.keyId === keyId && r.endedAt === null) ?? null;
  }

  async listActive(userId: string) {
    return this.rows.filter((r) => r.userId === userId && r.endedAt === null).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async connectOnce(record: AgentConnectionRecord) {
    const existing = await this.active(record.keyId);
    if (existing) return existing;
    this.rows.push(record);
    return record;
  }

  /** Tests only: end a key's connection, as revoke (a later piece) will. */
  endForTest(keyId: string, at: Date) {
    const i = this.rows.findIndex((r) => r.keyId === keyId && r.endedAt === null);
    if (i >= 0) this.rows[i] = { ...this.rows[i]!, endedAt: at };
  }
}

interface Row {
  key_id: string;
  user_id: string;
  account_id: string;
  created_at: Date;
  ended_at: Date | null;
}

const recordOf = (r: Row): AgentConnectionRecord => ({
  keyId: r.key_id,
  userId: r.user_id,
  accountId: r.account_id,
  createdAt: r.created_at,
  endedAt: r.ended_at,
});

const COLUMNS = 'key_id, user_id, account_id, created_at, ended_at';

export class SqlAgentConnectionStore implements AgentConnectionStore {
  constructor(private readonly sql: Sql) {}

  async active(keyId: string) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM trade.user_venue_agent_connections WHERE key_id = ${keyId} AND ended_at IS NULL`;
    return rows[0] ? recordOf(rows[0]) : null;
  }

  async listActive(userId: string) {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM trade.user_venue_agent_connections
      WHERE user_id = ${userId} AND ended_at IS NULL ORDER BY created_at, key_id`;
    return rows.map(recordOf);
  }

  async connectOnce(r: AgentConnectionRecord) {
    await this.sql`
      INSERT INTO trade.user_venue_agent_connections (key_id, user_id, account_id, created_at)
      VALUES (${r.keyId}, ${r.userId}, ${r.accountId}, ${r.createdAt})
      ON CONFLICT (key_id) WHERE ended_at IS NULL DO NOTHING`;
    const stored = await this.active(r.keyId);
    if (!stored) throw new Error(`the connection of key ${r.keyId} was not stored`);
    return stored;
  }
}
