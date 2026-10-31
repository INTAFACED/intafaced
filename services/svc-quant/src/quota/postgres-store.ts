import type { QuantQuotaUsage } from '@intafaced/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { QUANT_IDEMPOTENCY_CONFLICT, QuantError } from '../errors.js';
import {
  checkClaim,
  profileOf,
  QUOTA_RESOURCES,
  usageOf,
  zeroCounts,
  type QuotaAssignWrite,
  type QuotaClaim,
  type QuotaCounts,
  type QuotaLimitWrite,
  type QuotaResource,
} from './quota.js';

type Db = Sql | TransactionSql;

function relation(schema: string, table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || !/^[a-z_]+$/.test(table)) throw new Error(`refusing sql identifier ${schema}.${table}`);
  return `"${schema}"."${table}"`;
}

async function query<T>(db: Db, text: string, params: readonly unknown[]): Promise<T[]> {
  return db.unsafe(text, params as never[]);
}

/** The latest assignment of an account, or null. */
async function assignedProfile(db: Db, schema: string, accountId: string): Promise<string | null> {
  const rows = await query<{ profile: string }>(
    db,
    `SELECT profile FROM ${relation(schema, 'quota_assignments')} WHERE account_id = $1 ORDER BY seq DESC LIMIT 1`,
    [accountId],
  );
  return rows[0]?.profile ?? null;
}

/** The limits in force for a profile: the latest row per resource; a resource never set is absent (blank). */
async function limitsOf(db: Db, schema: string, profile: string): Promise<Map<QuotaResource, bigint | null>> {
  const rows = await query<{ resource: QuotaResource; limit_value: string | null }>(
    db,
    `SELECT DISTINCT ON (resource) resource, limit_value::text AS limit_value FROM ${relation(schema, 'quota_limits')}
      WHERE profile = $1 ORDER BY resource, seq DESC`,
    [profile],
  );
  return new Map(rows.map((row) => [row.resource, row.limit_value === null ? null : BigInt(row.limit_value)]));
}

/** The most a run may store (its result's byte cap) and the most log lines that result can hold, as one run reserves. */
export interface RunReserve {
  readonly bytes: bigint;
  readonly logLines: bigint;
}

/**
 * What the account holds now, counted from its stored rows, for the resources named. Saved strategies and versions
 * count those not in the recycle bin; stored bytes count every version kept, the bin's too. A run in progress has
 * stored no result yet, so it counts as the largest one it may store (`reserve`): two runs started at the limit can
 * never store past it together. A per-strategy resource counts the strategy named, or, with none named (the usage
 * view), the largest count of any one strategy. Collaborators and notifications do not exist in this service yet, so
 * nothing is counted for them.
 */
async function countsOf(
  db: Db,
  schema: string,
  accountId: string,
  strategyId: string | null,
  reserve: RunReserve,
  resources: readonly QuotaResource[],
): Promise<QuotaCounts> {
  const strategies = relation(schema, 'strategies');
  const versions = relation(schema, 'strategy_versions');
  const runs = relation(schema, 'runs');
  const inFlight = `(SELECT count(*) FROM ${runs} WHERE user_id = $1 AND finished_at IS NULL)`;
  const expressions: Partial<Record<QuotaResource, string>> = {
    strategies: `(SELECT count(*) FROM ${strategies} WHERE account_id = $1 AND deleted_at IS NULL)`,
    versions_per_strategy: `COALESCE((SELECT max(n) FROM (SELECT count(*) AS n FROM ${versions} v JOIN ${strategies} s ON s.id = v.strategy_id
       WHERE s.account_id = $1 AND s.deleted_at IS NULL AND (p.strategy_id IS NULL OR s.id = p.strategy_id) GROUP BY s.id) per), 0)`,
    concurrent_runs: inFlight,
    paper_runs: `(SELECT count(*) FROM ${runs} WHERE user_id = $1 AND kind = 'sandbox')`,
    stored_runs: `(SELECT count(*) FROM ${runs} WHERE user_id = $1)`,
    log_lines: `(COALESCE((SELECT sum(COALESCE(log_lines, CASE WHEN jsonb_typeof(result->'response'->'logs') = 'array'
       THEN jsonb_array_length(result->'response'->'logs') ELSE 0 END)) FROM ${runs} WHERE user_id = $1 AND finished_at IS NOT NULL), 0)
       + ${inFlight} * p.reserve_lines)`,
    storage_bytes: `(COALESCE((SELECT sum(octet_length(v.source)) FROM ${versions} v JOIN ${strategies} s ON s.id = v.strategy_id
       WHERE s.account_id = $1), 0)
       + COALESCE((SELECT sum(COALESCE(result_bytes, octet_length(result::text))) FROM ${runs}
          WHERE user_id = $1 AND finished_at IS NOT NULL AND result IS NOT NULL), 0)
       + ${inFlight} * p.reserve_bytes)`,
  };
  const counts = zeroCounts();
  const named = resources.filter((resource) => expressions[resource] !== undefined);
  if (!named.length) return counts;
  const [row] = await query<Record<string, string>>(
    db,
    `SELECT ${named.map((resource) => `${expressions[resource]}::text AS ${resource}`).join(', ')}
       FROM (SELECT $2::text AS strategy_id, $3::bigint AS reserve_bytes, $4::bigint AS reserve_lines) p`,
    [accountId, strategyId, String(reserve.bytes), String(reserve.logLines)],
  );
  for (const resource of named) if (row?.[resource] !== undefined) counts[resource] = BigInt(row[resource]!);
  return counts;
}

/** The quota check a write runs inside its own transaction, before it inserts. */
export type QuotaHold = (tx: TransactionSql, accountId: string, claim: QuotaClaim, strategyId: string | null) => Promise<void>;

/**
 * The check for one schema and the owner's default profile. Locks per account and resource in a fixed order, so two
 * writes racing at a limit queue behind each other and the second counts the first.
 */
export function postgresQuotaHold(schema: string, defaultProfile: string | null, reserve: RunReserve): QuotaHold {
  return async (tx, accountId, claim, strategyId) => {
    const claimed = QUOTA_RESOURCES.filter((resource) => claim[resource] !== undefined);
    for (const resource of claimed) {
      await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.quota:${accountId}:${resource}`]);
    }
    const profile = profileOf(await assignedProfile(tx, schema, accountId), defaultProfile);
    checkClaim(profile, await limitsOf(tx, schema, profile), await countsOf(tx, schema, accountId, strategyId, reserve, claimed), claim);
  };
}

export interface QuotaStore {
  setLimit(input: QuotaLimitWrite): Promise<{ profile: string; resource: QuotaResource; limit: string | null; seq: number }>;
  assign(input: QuotaAssignWrite): Promise<{ accountId: string; profile: string; seq: number }>;
  usage(accountId: string): Promise<QuantQuotaUsage>;
}

export function createPostgresQuotaStore(
  sql: Sql,
  schema: string,
  defaultProfile: string | null,
  reserve: RunReserve,
  now: () => Date = () => new Date(),
): QuotaStore {
  const limits = relation(schema, 'quota_limits');
  const assignments = relation(schema, 'quota_assignments');
  return {
    async setLimit(input) {
      return sql.begin(async (tx) => {
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.quota.key:${input.idempotencyKey}`]);
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.quota.set:${input.profile}:${input.resource}`]);
        const prior = await query<{ profile: string; resource: QuotaResource; limit_value: string | null; seq: number }>(
          tx,
          `SELECT profile, resource, limit_value::text AS limit_value, seq FROM ${limits} WHERE idempotency_key = $1`,
          [input.idempotencyKey],
        );
        const row =
          prior[0] ??
          (
            await query<{ profile: string; resource: QuotaResource; limit_value: string | null; seq: number }>(
              tx,
              `INSERT INTO ${limits} (profile, resource, seq, limit_value, reason, set_by, idempotency_key, set_at)
               VALUES ($1, $2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${limits} WHERE profile = $1 AND resource = $2), $3, $4, $5, $6, $7)
               RETURNING profile, resource, limit_value::text AS limit_value, seq`,
              [input.profile, input.resource, input.limit, input.reason, input.setBy, input.idempotencyKey, now().toISOString()],
            )
          )[0];
        if (!row) throw new QuantError('quant.params_invalid', 'quota limit was not stored');
        if (prior[0] && (row.profile !== input.profile || row.resource !== input.resource || row.limit_value !== input.limit)) {
          throw new QuantError(QUANT_IDEMPOTENCY_CONFLICT, 'idempotencyKey was used for a different quota limit');
        }
        return { profile: row.profile, resource: row.resource, limit: row.limit_value, seq: row.seq };
      });
    },

    async assign(input) {
      return sql.begin(async (tx) => {
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.quota.key:${input.idempotencyKey}`]);
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.quota.assign:${input.accountId}`]);
        const prior = await query<{ account_id: string; profile: string; seq: number }>(
          tx,
          `SELECT account_id, profile, seq FROM ${assignments} WHERE idempotency_key = $1`,
          [input.idempotencyKey],
        );
        const row =
          prior[0] ??
          (
            await query<{ account_id: string; profile: string; seq: number }>(
              tx,
              `INSERT INTO ${assignments} (account_id, seq, profile, reason, assigned_by, idempotency_key, assigned_at)
               VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${assignments} WHERE account_id = $1), $2, $3, $4, $5, $6)
               RETURNING account_id, profile, seq`,
              [input.accountId, input.profile, input.reason, input.assignedBy, input.idempotencyKey, now().toISOString()],
            )
          )[0];
        if (!row) throw new QuantError('quant.params_invalid', 'quota assignment was not stored');
        if (prior[0] && (row.account_id !== input.accountId || row.profile !== input.profile)) {
          throw new QuantError(QUANT_IDEMPOTENCY_CONFLICT, 'idempotencyKey was used for a different assignment');
        }
        return { accountId: row.account_id, profile: row.profile, seq: row.seq };
      });
    },

    async usage(accountId) {
      const profile = (await assignedProfile(sql, schema, accountId)) ?? defaultProfile;
      const counts = await countsOf(sql, schema, accountId, null, reserve, QUOTA_RESOURCES);
      return usageOf(profile, profile ? await limitsOf(sql, schema, profile) : new Map(), counts);
    },
  };
}
