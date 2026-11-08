import type { Sql, TransactionSql } from 'postgres';
import { claimBlock, type MarketingClaim } from '@intafaced/contracts';

/** A claim as stored: the wire shape (less its computed block) and the business key it was recorded under. */
export interface StoredClaim extends Omit<MarketingClaim, 'block'> {
  readonly key: string;
}

export interface ClaimLogEntry {
  readonly op: 'record' | 'publish';
  readonly outcome: 'created' | 'published' | 'noop' | 'refused';
  readonly actorId: string;
  readonly at: string;
  /** The refusal code, when the attempt was refused. */
  readonly code?: string | null;
}

/** The register inside one change: no other change runs until this one returns. */
export interface LockedClaims {
  byKey(key: string): Promise<StoredClaim | null>;
  byId(id: string): Promise<StoredClaim | null>;
  insert(row: StoredClaim, log: ClaimLogEntry): Promise<void>;
  publish(id: string, by: string, at: string, log: ClaimLogEntry): Promise<StoredClaim>;
  /** A no-op or a refusal is logged too, so the log shows every attempt. */
  log(id: string, log: ClaimLogEntry): Promise<void>;
}

export interface ClaimStore {
  /** Newest first. */
  list(limit: number): Promise<StoredClaim[]>;
  change<T>(fn: (locked: LockedClaims) => Promise<T>): Promise<T>;
}

export const toWire = ({ key: _key, ...c }: StoredClaim): MarketingClaim => ({ ...c, block: claimBlock(c) });

export class MemoryClaimStore implements ClaimStore {
  private readonly rows: StoredClaim[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  readonly log: (ClaimLogEntry & { id: string })[] = [];

  async list(limit: number): Promise<StoredClaim[]> {
    return [...this.rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit);
  }

  change<T>(fn: (locked: LockedClaims) => Promise<T>): Promise<T> {
    const locked: LockedClaims = {
      byKey: async (key) => this.rows.find((r) => r.key === key) ?? null,
      byId: async (id) => this.rows.find((r) => r.id === id) ?? null,
      insert: async (row, log) => {
        this.rows.push(row);
        this.log.push({ ...log, id: row.id });
      },
      publish: async (id, by, at, log) => {
        const i = this.rows.findIndex((r) => r.id === id);
        const next: StoredClaim = { ...this.rows[i]!, status: 'published', approverId: by, publishedAt: at };
        this.rows[i] = next;
        this.log.push({ ...log, id });
        return next;
      },
      log: async (id, log) => {
        this.log.push({ ...log, id });
      },
    };
    const run = this.queue.then(() => fn(locked));
    this.queue = run.catch(() => undefined);
    return run;
  }
}

type Row = {
  id: string;
  key: string;
  topic: string;
  text: string;
  evidence: string | null;
  status: MarketingClaim['status'];
  author_id: string;
  created_at: Date | string;
  approver_id: string | null;
  published_at: Date | string | null;
};

const at = (v: Date | string) => new Date(v).toISOString();

const fromRow = (r: Row): StoredClaim => ({
  id: r.id,
  key: r.key,
  topic: r.topic,
  text: r.text,
  evidence: r.evidence,
  status: r.status,
  authorId: r.author_id,
  createdAt: at(r.created_at),
  approverId: r.approver_id,
  publishedAt: r.published_at === null ? null : at(r.published_at),
});

const COLUMNS = 'id, key, topic, text, evidence, status, author_id, created_at, approver_id, published_at';

export class SqlClaimStore implements ClaimStore {
  constructor(private readonly sql: Sql) {}

  async list(limit: number): Promise<StoredClaim[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM ops.marketing_claims ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    return rows.map(fromRow);
  }

  async change<T>(fn: (locked: LockedClaims) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx: TransactionSql) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('ops.marketing_claims'))`;
      const one = (rows: Row[]) => (rows[0] ? fromRow(rows[0]) : null);
      const log = (id: string, entry: ClaimLogEntry) => tx`
        INSERT INTO ops.marketing_claim_log (claim_id, op, outcome, code, actor_id, logged_at)
        VALUES (${id}, ${entry.op}, ${entry.outcome}, ${entry.code ?? null}, ${entry.actorId}, ${entry.at})
      `;
      return fn({
        byKey: async (key) => one(await tx<Row[]>`SELECT ${tx.unsafe(COLUMNS)} FROM ops.marketing_claims WHERE key = ${key}`),
        byId: async (id) => one(await tx<Row[]>`SELECT ${tx.unsafe(COLUMNS)} FROM ops.marketing_claims WHERE id = ${id}`),
        insert: async (row, entry) => {
          await tx`
            INSERT INTO ops.marketing_claims (id, key, topic, text, evidence, status, author_id, created_at)
            VALUES (${row.id}, ${row.key}, ${row.topic}, ${row.text}, ${row.evidence}, 'draft', ${row.authorId}, ${row.createdAt})
          `;
          await log(row.id, entry);
        },
        publish: async (id, by, when, entry) => {
          const rows = await tx<Row[]>`
            UPDATE ops.marketing_claims SET status = 'published', approver_id = ${by}, published_at = ${when}
            WHERE id = ${id} AND status = 'draft' RETURNING ${tx.unsafe(COLUMNS)}
          `;
          await log(id, entry);
          return fromRow(rows[0]!);
        },
        log: async (id, entry) => {
          await log(id, entry);
        },
      });
    }) as Promise<T>;
  }
}
