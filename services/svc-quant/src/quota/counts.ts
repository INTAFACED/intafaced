import type { Db } from './quota.js';

function relation(schema: string, table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || !/^[a-z_]+$/.test(table)) throw new Error(`refusing sql identifier ${schema}.${table}`);
  return `"${schema}"."${table}"`;
}

/** What one account holds, counted from its stored rows. Bytes are the stored source text and the stored run results. */
export interface AccountCounts {
  readonly strategies: bigint;
  readonly mostVersions: bigint;
  readonly runs: bigint;
  readonly running: bigint;
  readonly paperRuns: bigint;
  readonly storage: bigint;
}

interface CountSql {
  strategies: string;
  most_versions: string;
  runs: string;
  running: string;
  paper_runs: string;
  storage: string;
}

/**
 * Every count a quota reads, in one statement, so a write that locked its counters reads them as they are committed.
 * Deleted strategies are in the recycle bin: they are not saved strategies, but their versions still take storage.
 */
export async function accountCounts(db: Db, schema: string, accountId: string): Promise<AccountCounts> {
  const strategies = relation(schema, 'strategies');
  const versions = relation(schema, 'strategy_versions');
  const runs = relation(schema, 'runs');
  const rows = await db.unsafe<CountSql[]>(
    `SELECT
       (SELECT COUNT(*) FROM ${strategies} s WHERE s.account_id = $1 AND s.deleted_at IS NULL)::text AS strategies,
       (SELECT COALESCE(MAX(n), 0) FROM (
          SELECT COUNT(*) AS n FROM ${versions} v JOIN ${strategies} s ON s.id = v.strategy_id
           WHERE s.account_id = $1 GROUP BY v.strategy_id) per)::text AS most_versions,
       (SELECT COUNT(*) FROM ${runs} r WHERE r.user_id = $1)::text AS runs,
       (SELECT COUNT(*) FROM ${runs} r WHERE r.user_id = $1 AND r.finished_at IS NULL)::text AS running,
       (SELECT COUNT(*) FROM ${runs} r WHERE r.user_id = $1 AND r.kind = 'paper')::text AS paper_runs,
       ((SELECT COALESCE(SUM(octet_length(v.source)), 0) FROM ${versions} v JOIN ${strategies} s ON s.id = v.strategy_id
          WHERE s.account_id = $1)
        + (SELECT COALESCE(SUM(octet_length(r.result::text)), 0) FROM ${runs} r WHERE r.user_id = $1))::text AS storage`,
    [accountId],
  );
  const row = rows[0];
  if (!row) throw new Error('account counts returned no row');
  return {
    strategies: BigInt(row.strategies),
    mostVersions: BigInt(row.most_versions),
    runs: BigInt(row.runs),
    running: BigInt(row.running),
    paperRuns: BigInt(row.paper_runs),
    storage: BigInt(row.storage),
  };
}

/** The versions one strategy has now. */
export async function versionCount(db: Db, schema: string, strategyId: string): Promise<bigint> {
  const rows = await db.unsafe<{ n: string }[]>(
    `SELECT COUNT(*)::text AS n FROM ${relation(schema, 'strategy_versions')} WHERE strategy_id = $1`,
    [strategyId],
  );
  return BigInt(rows[0]?.n ?? '0');
}

export const utf8Bytes = (text: string): bigint => BigInt(Buffer.byteLength(text, 'utf8'));
