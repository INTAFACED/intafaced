import type { Sql } from 'postgres';
import { z } from 'zod';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';

/**
 * The person's daily loss limit on their own venue account (daily-loss-limit.ts), held in
 * `trade.user_venue_daily_loss_limits` (drizzle/20261127100000_user_venue_daily_loss_limits.sql). A setting: no balance,
 * no post, nothing sent to the venue.
 */

export type DailyLossMode = 'advisory' | 'blocking';

export interface DailyLossTerms {
  readonly mode: DailyLossMode;
  readonly limit: Amount;
}

export interface DailyLossKey {
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
}

export interface DailyLossRecord extends DailyLossKey {
  readonly asset: string;
  /** In force now; null while off. */
  readonly active: DailyLossTerms | null;
  /** A loosening waiting until `effectiveAt`; `terms` null turns the limit off. */
  readonly pending: { readonly terms: DailyLossTerms | null; readonly effectiveAt: Date } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DailyLossLimitStore {
  get(key: DailyLossKey): Promise<DailyLossRecord | null>;
  /** One change, under the row's lock: `fn` sees the record as stored (null: none yet) and returns what is stored. */
  update(key: DailyLossKey, fn: (current: DailyLossRecord | null) => DailyLossRecord): Promise<DailyLossRecord>;
}

const id = (k: DailyLossKey) => `${k.userId}\n${k.venueId}\n${k.owner}`;

export class InMemoryDailyLossLimitStore implements DailyLossLimitStore {
  readonly rows = new Map<string, DailyLossRecord>();
  async get(key: DailyLossKey) {
    return this.rows.get(id(key)) ?? null;
  }
  async update(key: DailyLossKey, fn: (current: DailyLossRecord | null) => DailyLossRecord) {
    const next = fn(this.rows.get(id(key)) ?? null);
    this.rows.set(id(key), next);
    return next;
  }
}

const Row = z.object({
  user_id: z.string(),
  venue_id: z.string(),
  owner: z.string(),
  asset: z.string(),
  mode: z.enum(['advisory', 'blocking']).nullable(),
  limit_amount: z.string().nullable(),
  pending: z.boolean(),
  pending_mode: z.enum(['advisory', 'blocking']).nullable(),
  pending_limit: z.string().nullable(),
  pending_effective_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
type Row = z.infer<typeof Row>;

const terms = (mode: DailyLossMode | null, limit: string | null): DailyLossTerms | null =>
  mode === null || limit === null ? null : { mode, limit: parseAmount(limit) };

const recordOf = (r: Row): DailyLossRecord => ({
  userId: r.user_id,
  venueId: r.venue_id,
  owner: r.owner,
  asset: r.asset,
  active: terms(r.mode, r.limit_amount),
  pending:
    r.pending && r.pending_effective_at ? { terms: terms(r.pending_mode, r.pending_limit), effectiveAt: r.pending_effective_at } : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqlDailyLossLimitStore implements DailyLossLimitStore {
  constructor(private readonly sql: Sql) {}

  async get({ userId, venueId, owner }: DailyLossKey) {
    const rows = Row.array().parse(
      await this.sql`
      SELECT * FROM trade.user_venue_daily_loss_limits WHERE user_id = ${userId} AND venue_id = ${venueId} AND owner = ${owner}`,
    );
    return rows[0] ? recordOf(rows[0]) : null;
  }

  async update(key: DailyLossKey, fn: (current: DailyLossRecord | null) => DailyLossRecord) {
    return this.sql.begin(async (tx) => {
      const locked = Row.array().parse(
        await tx`
        SELECT * FROM trade.user_venue_daily_loss_limits
        WHERE user_id = ${key.userId} AND venue_id = ${key.venueId} AND owner = ${key.owner}
        FOR UPDATE`,
      );
      const next = fn(locked[0] ? recordOf(locked[0]) : null);
      const a = next.active;
      const p = next.pending;
      const amt = (v: Amount | undefined) => (v === undefined ? null : formatAmount(v));
      const rows = Row.array().parse(
        await tx`
        INSERT INTO trade.user_venue_daily_loss_limits
          (user_id, venue_id, owner, asset, mode, limit_amount, pending, pending_mode, pending_limit, pending_effective_at,
           created_at, updated_at)
        VALUES (${key.userId}, ${key.venueId}, ${key.owner}, ${next.asset}, ${a?.mode ?? null}, ${amt(a?.limit)},
          ${p !== null}, ${p?.terms?.mode ?? null}, ${amt(p?.terms?.limit)}, ${p?.effectiveAt ?? null},
          ${next.createdAt}, ${next.updatedAt})
        ON CONFLICT (user_id, venue_id, owner) DO UPDATE SET
          mode = EXCLUDED.mode,
          limit_amount = EXCLUDED.limit_amount,
          pending = EXCLUDED.pending,
          pending_mode = EXCLUDED.pending_mode,
          pending_limit = EXCLUDED.pending_limit,
          pending_effective_at = EXCLUDED.pending_effective_at,
          updated_at = EXCLUDED.updated_at
        RETURNING *`,
      );
      const row = rows[0];
      if (!row) throw new Error('trade.user_venue_daily_loss_limits: the save returned no row');
      return recordOf(row);
    });
  }
}

/**
 * The TEST age door's subject (`daily-loss-limit`, svc-trade src/test-age-door.ts): the waiting loosening of the venue
 * account `owner` is moved `ms` earlier, as if that much time had gone by, so a journey sees its 24 hours pass on a TEST
 * clock. A limit with nothing waiting is not touched (answers null). Test stacks only: the door is shut elsewhere.
 */
export function ageDailyLossLimit(sql: Sql) {
  return async (owner: string, ms: number) => {
    const rows = z
      .object({ pending_effective_at: z.date() })
      .array()
      .parse(
        await sql`
          UPDATE trade.user_venue_daily_loss_limits
          SET pending_effective_at = pending_effective_at - make_interval(secs => ${ms / 1000}),
              updated_at = updated_at - make_interval(secs => ${ms / 1000})
          WHERE owner = ${owner.toLowerCase()} AND pending
          RETURNING pending_effective_at`,
      );
    const row = rows[0];
    return row ? { pendingEffectiveAt: row.pending_effective_at.toISOString() } : null;
  };
}
