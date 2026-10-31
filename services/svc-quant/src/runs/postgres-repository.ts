import type { Sql, TransactionSql } from 'postgres';
import { QUANT_RUN_IMMUTABLE, QUANT_RUN_NOT_FOUND, QuantError } from '../errors.js';
import { decodeListCursor, encodeListCursor, idempotencyConflict } from '../studio/keys.js';
import { assertResultFits, assertRunResultCap } from './limit.js';
import type { QuotaClaim } from '../quota/quota.js';
import type { QuotaHold } from '../quota/postgres-store.js';
import type { BeginRun, ClaimInput, FinishRun, RunRepository } from './repository.js';
import type { ClaimRow, CostBreakdown, RunCounts, RunKind, RunResultBody, StoredRun, StoredRunResult } from './types.js';

interface RunSql {
  id: string;
  user_id: string | null;
  scope_key: string;
  idempotency_key: string;
  kind: string;
  strategy_id: string | null;
  strategy_version: number | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  outcome_code: string | null;
  result: unknown;
}

interface ClaimSql {
  id: string;
  run_id: string;
  user_id: string;
  idempotency_key: string;
  pnl: string;
  environment: string;
  kind: string;
  claim_label: string;
  live: boolean;
  simulated: boolean;
  created_at: Date | string;
}

function relation(schema: string, table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || !/^[a-z_]+$/.test(table)) {
    throw new Error(`refusing sql identifier ${schema}.${table}`);
  }
  return `"${schema}"."${table}"`;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new QuantError('quant.params_invalid', 'timestamp is not readable');
  return date.toISOString();
}

function scopeKey(userId: string | null): string {
  return userId ?? 'anonymous';
}

function durationOf(started: string, finished: string | null): number | null {
  if (!finished) return null;
  return Date.parse(finished) - Date.parse(started);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === '23505';
}

function isImmutable(err: unknown): boolean {
  return err instanceof Error && err.message.includes('quant.run_immutable');
}

function readKind(value: string): RunKind {
  if (value !== 'backtest' && value !== 'sandbox') throw new QuantError('quant.params_invalid', 'run kind is not backtest or sandbox');
  return value;
}

function readEnvironment(value: string): ClaimRow['environment'] {
  if (value !== 'paper' && value !== 'backtest' && value !== 'shadow') {
    throw new QuantError('quant.params_invalid', 'environment is not paper, backtest, or shadow');
  }
  return value;
}

function readStampKind(value: string): ClaimRow['kind'] {
  if (value !== 'paper' && value !== 'simulated') throw new QuantError('quant.params_invalid', 'kind is not paper or simulated');
  return value;
}

function readLabel(value: string): ClaimRow['claimLabel'] {
  if (
    value !== 'Paper — not live performance' &&
    value !== 'Historical simulation — not a forecast' &&
    value !== 'Shadow — not live performance'
  ) {
    throw new QuantError('quant.params_invalid', 'claimLabel is not a paper stamp');
  }
  return value;
}

function readCosts(value: unknown): CostBreakdown | null {
  if (value == null) return null;
  if (typeof value !== 'object') throw new QuantError('quant.params_invalid', 'costs must be evidence or null');
  const rec = value as Record<string, unknown>;
  return {
    fees: readEvidence(rec.fees),
    slippage: readEvidence(rec.slippage),
    latency: readEvidence(rec.latency),
  };
}

function readEvidence(value: unknown): { kind: string; source: string } | null {
  if (value == null) return null;
  if (typeof value !== 'object') throw new QuantError('quant.params_invalid', 'cost evidence must be kind and source');
  const rec = value as Record<string, unknown>;
  if (typeof rec.kind !== 'string' || typeof rec.source !== 'string') {
    throw new QuantError('quant.params_invalid', 'cost evidence must be kind and source');
  }
  return { kind: rec.kind, source: rec.source };
}

function readBody(value: unknown): RunResultBody | null {
  if (value == null) return null;
  if (typeof value !== 'object') throw new QuantError('quant.params_invalid', 'run detail must be an object');
  const rec = value as Record<string, unknown>;
  if (rec.simulated !== true || rec.live !== false) throw new QuantError('quant.params_invalid', 'live must stay false');
  if (typeof rec.environment !== 'string' || (rec.kind !== 'paper' && rec.kind !== 'simulated') || typeof rec.claimLabel !== 'string') {
    throw new QuantError('quant.params_invalid', 'run detail stamp is incomplete');
  }
  return {
    equityCurve: Array.isArray(rec.equityCurve) ? (rec.equityCurve as RunResultBody['equityCurve']) : null,
    trades: Array.isArray(rec.trades) ? (rec.trades as RunResultBody['trades']) : null,
    costs: readCosts(rec.costs),
    pnl: typeof rec.pnl === 'string' ? rec.pnl : null,
    simulated: true,
    live: false,
    environment: rec.environment,
    kind: rec.kind,
    claimLabel: rec.claimLabel,
  };
}

function readStored(value: unknown): { detail: RunResultBody | null; response: unknown } {
  if (value == null || typeof value !== 'object') return { detail: null, response: null };
  const rec = value as Record<string, unknown>;
  if ('detail' in rec || 'response' in rec) {
    return { detail: readBody(rec.detail), response: rec.response ?? null };
  }
  return { detail: readBody(value), response: null };
}

function runOf(row: RunSql): StoredRun {
  const stored = readStored(row.result);
  return {
    id: row.id,
    userId: row.user_id,
    kind: readKind(row.kind),
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    started: iso(row.started_at),
    finished: row.finished_at ? iso(row.finished_at) : null,
    outcome: row.outcome_code,
    detail: stored.detail,
    response: stored.response,
    idempotencyKey: row.idempotency_key,
  };
}

function claimOf(row: ClaimSql): ClaimRow {
  if (row.live !== false || row.simulated !== true) throw new QuantError('quant.params_invalid', 'live must stay false');
  return {
    id: row.id,
    runId: row.run_id,
    userId: row.user_id,
    pnl: row.pnl,
    environment: readEnvironment(row.environment),
    kind: readStampKind(row.kind),
    claimLabel: readLabel(row.claim_label),
    live: false,
    simulated: true,
    createdAt: iso(row.created_at),
  };
}

/**
 * What a new run counts against the plan (AL-limits-01): one more run in progress and stored, a paper run for the
 * sandbox kind, and at least one more log line and stored byte, so a run refuses once either has reached its limit.
 */
function runClaim(kind: RunKind): QuotaClaim {
  return {
    concurrent_runs: 1n,
    stored_runs: 1n,
    ...(kind === 'sandbox' ? { paper_runs: 1n } : {}),
    log_lines: 1n,
    storage_bytes: 1n,
  };
}

/**
 * `quota` is the plan check a new run makes inside the transaction that inserts it. The service always passes it; a
 * store built without one (a test of something else) does not count.
 */
export function createPostgresRunRepository(
  sql: Sql,
  schema = 'quant',
  cap: number | null | undefined = undefined,
  quota?: QuotaHold,
): RunRepository {
  const resultCap = assertRunResultCap(cap);
  const runs = relation(schema, 'runs');
  const claims = relation(schema, 'claims');
  const runLabels = relation(schema, 'run_labels');

  async function query<T>(db: Sql | TransactionSql, text: string, params: readonly unknown[]): Promise<T[]> {
    return db.unsafe(text, params as never[]);
  }

  async function loadByKey(db: Sql | TransactionSql, userId: string | null, idempotencyKey: string): Promise<StoredRun | null> {
    const rows = await query<RunSql>(db, `SELECT * FROM ${runs} WHERE scope_key = $1 AND idempotency_key = $2`, [
      scopeKey(userId),
      idempotencyKey,
    ]);
    const row = rows[0];
    return row ? runOf(row) : null;
  }

  return {
    async replay(userId, idempotencyKey) {
      return loadByKey(sql, userId, idempotencyKey);
    },

    async begin(input: BeginRun) {
      const existing = await loadByKey(sql, input.userId, input.idempotencyKey);
      if (existing) return existing;
      const id = `run_${crypto.randomUUID()}`;
      const insert = async (db: Sql | TransactionSql) => {
        const rows = await query<RunSql>(
          db,
          `INSERT INTO ${runs}
             (id, user_id, scope_key, idempotency_key, kind, strategy_id, strategy_version, started_at, finished_at, outcome_code, result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, NULL)
           RETURNING *`,
          [
            id,
            input.userId,
            scopeKey(input.userId),
            input.idempotencyKey,
            input.kind,
            input.strategyId,
            input.strategyVersion,
            new Date().toISOString(),
          ],
        );
        const row = rows[0];
        if (!row) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
        return runOf(row);
      };
      const userId = input.userId;
      try {
        // A run with no account (a service call) has no plan to count against.
        if (!quota || !userId) return await insert(sql);
        return await sql.begin(async (tx) => {
          // A replay of a run that started meanwhile returns it and is never counted again; a replay that lands after
          // this read meets the unique key below and is read back the same way.
          const raced = await loadByKey(tx, userId, input.idempotencyKey);
          if (raced) return raced;
          await quota(tx, userId, runClaim(input.kind), null);
          return insert(tx);
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const again = await loadByKey(sql, input.userId, input.idempotencyKey);
        if (!again) throw err;
        return again;
      }
    },

    async finish(input: FinishRun) {
      assertResultFits(input.stored, resultCap);
      const payload: StoredRunResult = { detail: input.stored.detail, response: input.stored.response ?? null };
      try {
        const rows = await query<RunSql>(
          sql,
          `UPDATE ${runs}
             SET finished_at = $3, outcome_code = $4, result = $5::jsonb
           WHERE id = $1 AND scope_key = $2 AND finished_at IS NULL
           RETURNING *`,
          [input.id, scopeKey(input.userId), new Date().toISOString(), input.outcome, payload],
        );
        const row = rows[0];
        if (row) return runOf(row);
      } catch (err) {
        if (isImmutable(err)) throw new QuantError(QUANT_RUN_IMMUTABLE, 'run cannot be rewritten');
        throw err;
      }
      const current = await query<RunSql>(sql, `SELECT * FROM ${runs} WHERE id = $1 AND scope_key = $2`, [
        input.id,
        scopeKey(input.userId),
      ]);
      if (current[0]?.finished_at) throw new QuantError(QUANT_RUN_IMMUTABLE, 'run cannot be rewritten');
      throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
    },

    async get(input) {
      const rows = await query<RunSql>(sql, `SELECT * FROM ${runs} WHERE id = $1 AND user_id = $2`, [input.id, input.userId]);
      const row = rows[0];
      return row ? runOf(row) : null;
    },

    async list(input) {
      const cursor = input.cursor ? decodeListCursor(input.cursor) : null;
      const rows = await query<RunSql>(
        sql,
        `SELECT id, user_id, scope_key, idempotency_key, kind, strategy_id, strategy_version, started_at, finished_at, outcome_code, NULL::jsonb AS result
         FROM ${runs}
         WHERE ($1::timestamptz IS NULL OR started_at >= $1::timestamptz)
           AND ($2::timestamptz IS NULL OR started_at < $2::timestamptz)
           AND ($3::text IS NULL OR kind = $3)
           AND ($4::uuid IS NULL OR user_id = $4::uuid)
           AND ($5::timestamptz IS NULL OR (started_at, id) > ($5::timestamptz, $6::text))
         ORDER BY started_at ASC, id ASC
         LIMIT $7`,
        [input.from, input.to, input.kind, input.userId, cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1],
      );
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        runs: page.map((row) => {
          const started = iso(row.started_at);
          const finished = row.finished_at ? iso(row.finished_at) : null;
          return {
            id: row.id,
            kind: readKind(row.kind),
            userId: row.user_id,
            started,
            duration: durationOf(started, finished),
            outcome: row.outcome_code,
          };
        }),
        nextCursor: rows.length > input.limit && last ? encodeListCursor(iso(last.started_at), last.id) : null,
      };
    },

    async history(input) {
      const cursor = input.cursor ? decodeListCursor(input.cursor) : null;
      const rows = await query<RunSql & { label: string | null }>(
        sql,
        `SELECT r.id, r.user_id, r.scope_key, r.idempotency_key, r.kind, r.strategy_id, r.strategy_version, r.started_at,
                r.finished_at, r.outcome_code, NULL::jsonb AS result, l.label
         FROM ${runs} r
         LEFT JOIN ${runLabels} l ON l.run_id = r.id AND l.user_id = r.user_id
         WHERE r.user_id = $1::uuid
           AND r.kind = $2
           AND starts_with(r.idempotency_key, $6)
           AND ($7::text IS NULL OR r.strategy_id = $7::text)
           AND ($3::timestamptz IS NULL OR (r.started_at, r.id) < ($3::timestamptz, $4::text))
         ORDER BY r.started_at DESC, r.id DESC
         LIMIT $5`,
        [
          input.userId,
          input.kind,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          input.limit + 1,
          input.keyPrefix,
          input.strategyId ?? null,
        ],
      );
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        runs: page.map((row) => ({
          id: row.id,
          strategyId: row.strategy_id,
          strategyVersion: row.strategy_version,
          started: iso(row.started_at),
          finished: row.finished_at ? iso(row.finished_at) : null,
          outcome: row.outcome_code,
          label: row.label,
        })),
        nextCursor: rows.length > input.limit && last ? encodeListCursor(iso(last.started_at), last.id) : null,
      };
    },

    async variantCount(input) {
      const rows = await query<{ n: string }>(
        sql,
        `SELECT count(*)::text AS n
         FROM ${runs}
         WHERE user_id = $1::uuid
           AND kind = 'backtest'
           AND outcome_code = 'ok'
           AND strategy_id = $2
           AND starts_with(idempotency_key, $3)
           AND result -> 'response' ->> 'symbol' = $4
           AND result -> 'response' -> 'coverage' ->> 'barSize' = $5`,
        [input.userId, input.strategyId, input.keyPrefix, input.symbol, input.barSize],
      );
      return Number(rows[0]?.n ?? 0);
    },

    async setLabel(input) {
      // One statement: the label row is written only when the run is the caller's own.
      const rows = await query<{ label: string }>(
        sql,
        `INSERT INTO ${runLabels} (run_id, user_id, label, updated_at)
         SELECT r.id, r.user_id, $3, now() FROM ${runs} r WHERE r.id = $1 AND r.user_id = $2::uuid
         ON CONFLICT (run_id) DO UPDATE SET label = EXCLUDED.label, updated_at = EXCLUDED.updated_at
           WHERE ${runLabels}.user_id = EXCLUDED.user_id
         RETURNING label`,
        [input.runId, input.userId, input.label],
      );
      if (!rows[0]) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
      return { label: rows[0].label };
    },

    async okKinds(input) {
      const ok = (kind: RunKind) =>
        `EXISTS (SELECT 1 FROM ${runs} WHERE user_id = $1::uuid AND kind = '${kind}' AND finished_at IS NOT NULL AND outcome_code = 'ok')`;
      const rows = await query<{ backtest: boolean; sandbox: boolean }>(
        sql,
        `SELECT ${ok('backtest')} AS backtest, ${ok('sandbox')} AS sandbox`,
        [input.userId],
      );
      return { backtest: rows[0]?.backtest === true, sandbox: rows[0]?.sandbox === true };
    },

    async counts(input) {
      const rows = await query<{ kind: string; outcome_code: string | null; n: string }>(
        sql,
        `SELECT kind, outcome_code, count(*)::text AS n
         FROM ${runs}
         WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz
         GROUP BY kind, outcome_code`,
        [input.from, input.to],
      );
      const byOutcome = new Map<string, number>();
      let backtest = 0;
      let sandbox = 0;
      for (const row of rows) {
        const count = Number(row.n);
        if (!Number.isInteger(count)) throw new QuantError('quant.params_invalid', 'run count is not an integer');
        if (row.kind === 'backtest') backtest += count;
        if (row.kind === 'sandbox') sandbox += count;
        const outcome = row.outcome_code ?? '';
        byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + count);
      }
      return {
        byKind: { backtest, sandbox },
        byOutcome: [...byOutcome.entries()].map(([outcome, count]) => ({ outcome, count })),
        asOf: new Date().toISOString(),
      };
    },

    async claimOnce(input: ClaimInput) {
      return sql.begin(async (tx) => {
        const byRun = await query<ClaimSql>(tx, `SELECT * FROM ${claims} WHERE run_id = $1`, [input.runId]);
        if (byRun[0]) {
          if (byRun[0].user_id !== input.userId) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
          return claimOf(byRun[0]);
        }
        const byKey = await query<ClaimSql>(tx, `SELECT * FROM ${claims} WHERE user_id = $1 AND idempotency_key = $2`, [
          input.userId,
          input.idempotencyKey,
        ]);
        if (byKey[0]) {
          if (byKey[0].run_id !== input.runId) idempotencyConflict('claim');
          return claimOf(byKey[0]);
        }
        try {
          const inserted = await query<ClaimSql>(
            tx,
            `INSERT INTO ${claims}
               (id, run_id, user_id, idempotency_key, pnl, environment, kind, claim_label, live, simulated, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, true, $9)
             RETURNING *`,
            [
              input.id,
              input.runId,
              input.userId,
              input.idempotencyKey,
              input.pnl,
              input.environment,
              input.kind,
              input.claimLabel,
              new Date().toISOString(),
            ],
          );
          const row = inserted[0];
          if (!row) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
          return claimOf(row);
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          const again = await query<ClaimSql>(tx, `SELECT * FROM ${claims} WHERE run_id = $1`, [input.runId]);
          if (again[0] && again[0].user_id === input.userId) return claimOf(again[0]);
          idempotencyConflict('claim');
        }
      });
    },
  };
}
