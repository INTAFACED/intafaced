import type { Sql } from 'postgres';
import { QUANT_IDEMPOTENCY_CONFLICT, QuantError } from '../errors.js';
import { accountCounts } from './counts.js';
import {
  isQuotaResource,
  judgeNeeds,
  QUOTA_RESOURCES,
  type AppliedProfile,
  type Db,
  type QuotaGate,
  type QuotaLimitRow,
  type QuotaRepository,
  type QuotaResource,
  type QuotaSeed,
} from './quota.js';

function relation(schema: string, table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || !/^[a-z_]+$/.test(table)) throw new Error(`refusing sql identifier ${schema}.${table}`);
  return `"${schema}"."${table}"`;
}

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

interface LimitSql {
  resource: string;
  limit_value: string | null;
  set_at: Date | string;
}

export interface PostgresQuotaOptions {
  readonly schema?: string;
  /** The owner's default profile for an account with no assignment. Null refuses `quant.quota_profile_unset`. */
  readonly defaultProfile: string | null;
  /** The TEST stack's seeded profile; inserted once, never over a row an operator set. Null everywhere else. */
  readonly seed?: QuotaSeed | null;
  readonly now?: () => Date;
}

/** Quota profiles, assignments and their audit rows in Postgres, and the gate the counted writes call in their transactions. */
export function createPostgresQuota(sql: Sql, options: PostgresQuotaOptions): { repository: QuotaRepository; gate: QuotaGate } {
  const schema = options.schema ?? 'quant';
  const limitsTable = relation(schema, 'quota_limits');
  const assignments = relation(schema, 'quota_assignments');
  const audit = relation(schema, 'quota_audit');
  const now = options.now ?? (() => new Date());
  const seed = options.seed ?? null;
  let seeded: Promise<void> | null = null;

  async function query<T>(db: Db, text: string, params: readonly unknown[]): Promise<T[]> {
    return db.unsafe(text, params as never[]);
  }

  /** The TEST seed, on its own connection so a refused write that rolls back never takes the seed with it. */
  function ensureSeed(): Promise<void> {
    if (!seed) return Promise.resolve();
    seeded ??= (async () => {
      for (const resource of QUOTA_RESOURCES) {
        const value = seed.limits[resource];
        if (value === undefined) continue;
        await query(
          sql,
          `INSERT INTO ${limitsTable} (profile, resource, limit_value, reason, set_by, set_at)
           VALUES ($1, $2, $3::numeric, 'TEST profile seeded on the local and CI stack', 'svc-quant:test-seed', $4)
           ON CONFLICT (profile, resource) DO NOTHING`,
          [seed.profile, resource, value, now().toISOString()],
        );
      }
    })().catch((err) => {
      seeded = null;
      throw err;
    });
    return seeded;
  }

  async function appliedIn(db: Db, accountId: string): Promise<AppliedProfile | null> {
    const rows = await query<{ profile: string }>(db, `SELECT profile FROM ${assignments} WHERE account_id = $1`, [accountId]);
    if (rows[0]) return { name: rows[0].profile, source: 'assigned' };
    return options.defaultProfile ? { name: options.defaultProfile, source: 'default' } : null;
  }

  async function limitsIn(db: Db, profile: string): Promise<QuotaLimitRow[]> {
    const rows = await query<LimitSql>(
      db,
      `SELECT resource, limit_value::text AS limit_value, set_at FROM ${limitsTable} WHERE profile = $1`,
      [profile],
    );
    return rows
      .filter((row) => isQuotaResource(row.resource))
      .map((row) => ({
        resource: row.resource as QuotaResource,
        limit: row.limit_value === null ? null : BigInt(row.limit_value),
        setAt: iso(row.set_at),
      }));
  }

  /** A stored operator write under this key: the same write replays it, a different one refuses. */
  async function priorWrite<T>(db: Db, key: string, action: string, same: (stored: Record<string, unknown>) => boolean): Promise<T | null> {
    const rows = await query<{ action: string; request: Record<string, unknown>; response: T }>(
      db,
      `SELECT action, request, response FROM ${audit} WHERE idempotency_key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.action !== action || !same(row.request)) {
      throw new QuantError(QUANT_IDEMPOTENCY_CONFLICT, 'idempotencyKey was used for a different quota write');
    }
    return row.response;
  }

  const repository: QuotaRepository = {
    async applied(accountId) {
      return appliedIn(sql, accountId);
    },

    async counts(accountId) {
      return accountCounts(sql, schema, accountId);
    },

    async limits(profile) {
      await ensureSeed();
      return limitsIn(sql, profile);
    },

    async set(input) {
      await ensureSeed();
      const request = { profile: input.profile, resource: input.resource, limit: input.limit === null ? null : input.limit.toString() };
      return sql.begin(async (tx) => {
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.quota.key:${input.idempotencyKey}`]);
        const prior = await priorWrite<{ profile: string; resource: QuotaResource; limit: string | null; setAt: string }>(
          tx,
          input.idempotencyKey,
          'set',
          (stored) => stored.profile === request.profile && stored.resource === request.resource && stored.limit === request.limit,
        );
        if (prior) return { ...prior, limit: prior.limit === null ? null : BigInt(prior.limit) };
        const at = now().toISOString();
        await query(
          tx,
          `INSERT INTO ${limitsTable} (profile, resource, limit_value, reason, set_by, set_at)
           VALUES ($1, $2, $3::numeric, $4, $5, $6)
           ON CONFLICT (profile, resource) DO UPDATE
             SET limit_value = EXCLUDED.limit_value, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
          [input.profile, input.resource, request.limit, input.reason, input.actor, at],
        );
        const response = { ...request, setAt: at };
        await query(
          tx,
          `INSERT INTO ${audit} (idempotency_key, action, request, response, reason, actor, at)
           VALUES ($1, 'set', $2::jsonb, $3::jsonb, $4, $5, $6)`,
          [input.idempotencyKey, request, response, input.reason, input.actor, at],
        );
        return { ...response, resource: input.resource, limit: input.limit };
      });
    },

    async assign(input) {
      const request = { accountId: input.accountId, profile: input.profile };
      return sql.begin(async (tx) => {
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.quota.key:${input.idempotencyKey}`]);
        const prior = await priorWrite<{ accountId: string; profile: string; assignedAt: string }>(
          tx,
          input.idempotencyKey,
          'assign',
          (stored) => stored.accountId === request.accountId && stored.profile === request.profile,
        );
        if (prior) return prior;
        const at = now().toISOString();
        await query(
          tx,
          `INSERT INTO ${assignments} (account_id, profile, reason, assigned_by, assigned_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (account_id) DO UPDATE
             SET profile = EXCLUDED.profile, reason = EXCLUDED.reason, assigned_by = EXCLUDED.assigned_by, assigned_at = EXCLUDED.assigned_at`,
          [input.accountId, input.profile, input.reason, input.actor, at],
        );
        const response = { ...request, assignedAt: at };
        await query(
          tx,
          `INSERT INTO ${audit} (idempotency_key, action, request, response, reason, actor, at)
           VALUES ($1, 'assign', $2::jsonb, $3::jsonb, $4, $5, $6)`,
          [input.idempotencyKey, request, response, input.reason, input.actor, at],
        );
        return response;
      });
    },
  };

  const gate: QuotaGate = {
    async lock(db, accountId, resources) {
      if (!db) throw new Error('the Postgres quota gate locks inside a transaction');
      const unique = QUOTA_RESOURCES.filter((resource) => resources.includes(resource));
      for (const resource of unique) {
        await query(db, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.quota:${accountId}:${resource}`]);
      }
    },
    async check(db, accountId, needs) {
      if (!db) throw new Error('the Postgres quota gate checks inside a transaction');
      if (needs.length === 0) return;
      await ensureSeed();
      const profile = await appliedIn(db, accountId);
      const limits = profile ? await limitsIn(db, profile.name) : [];
      judgeNeeds(profile, (resource) => limits.find((row) => row.resource === resource)?.limit ?? null, needs);
    },
  };

  return { repository, gate };
}
