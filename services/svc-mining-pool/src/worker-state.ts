import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { canonicalWeight } from './decimal.js';
import { publishedInt } from './env.js';
import { MiningError } from './errors.js';

/**
 * A worker's connectivity, its recorded state changes, maintenance and alert limit (J-more-catalogue-06 #3, #4, #6).
 *
 * The miner door keeps no lasting connection, so a worker is online exactly when its newest accepted share is younger
 * than the owner's quiet interval (`MINING_WORKER_QUIET_SECONDS`), and offline otherwise. Every comparison uses the
 * database clock. A change between the two is recorded once, as a row keyed by a business key
 * (`mining:worker-offline:<workerId>:<newest share ISO>`, `mining:worker-online:…`), so a repeat evaluation or a second
 * evaluator writes nothing new. Only the evaluator records: a read writes nothing. A worker in maintenance gets no row. A worker that
 * has never sent an accepted share was never online, so it gets none either.
 *
 * `state` is what the room shows: `maintenance` while the worker is in it, else `offline` when quiet, else `active`.
 */

export const QUIET_INTERVAL_UNSET = 'mining.quiet_interval_unset';
export const QUIET_INTERVAL_INVALID = 'mining.quiet_interval_invalid';
export const EVALUATE_INTERVAL_UNSET = 'mining.worker_evaluate_unset';
export const EVALUATE_INTERVAL_INVALID = 'mining.worker_evaluate_invalid';
export const ALERT_LIMIT_UNSET = 'mining.alert_limit_unset';
export const ALERT_LIMIT_INVALID = 'mining.alert_limit_invalid';
export const WORKER_NOT_FOUND = 'mining.worker_not_found';
const NO_SHARES = 'no_shares_in_window' as const;

export const QUIET_SECONDS_MIN = 10;
export const QUIET_SECONDS_MAX = 86_400;
export const EVALUATE_SECONDS_MIN = 1;
export const EVALUATE_SECONDS_MAX = 3_600;
export const ALERT_SHARE_BPS_MAX = 10_000;
/** A manual alert limit: a positive decimal of at most 20 whole digits and 18 places, the numeric(38, 18) column. */
export const ALERT_LIMIT = /^(0|[1-9]\d{0,19})(\.\d{1,18})?$/;
export const MAINTENANCE_BATCH_MAX = 50;
const STATE_CHANGES_SHOWN = 100;

export type Connectivity = 'online' | 'offline';
export type WorkerState = 'active' | 'offline' | 'maintenance';
export type AlertLimitMode = 'automatic' | 'manual';

/** The quiet interval in seconds, or the code that refuses a read that needs it. */
export function quietSecondsOf(env: NodeJS.ProcessEnv): number | typeof QUIET_INTERVAL_UNSET | typeof QUIET_INTERVAL_INVALID {
  const n = publishedInt(env.MINING_WORKER_QUIET_SECONDS, QUIET_SECONDS_MIN, QUIET_SECONDS_MAX);
  if (n === null) return QUIET_INTERVAL_UNSET;
  if (n === 'invalid') return QUIET_INTERVAL_INVALID;
  return n;
}

/** How often the evaluator looks, in seconds, or the code that keeps it off. */
export function evaluateSecondsOf(env: NodeJS.ProcessEnv): number | typeof EVALUATE_INTERVAL_UNSET | typeof EVALUATE_INTERVAL_INVALID {
  const n = publishedInt(env.MINING_WORKER_EVALUATE_SECONDS, EVALUATE_SECONDS_MIN, EVALUATE_SECONDS_MAX);
  if (n === null) return EVALUATE_INTERVAL_UNSET;
  if (n === 'invalid') return EVALUATE_INTERVAL_INVALID;
  return n;
}

/** The owner's share of a worker's trailing hashrate an automatic alert limit is, in basis points; null when blank or unusable. */
export function alertShareBpsOf(env: NodeJS.ProcessEnv): number | null {
  const n = publishedInt(env.MINING_WORKER_ALERT_SHARE_BPS, 1, ALERT_SHARE_BPS_MAX);
  return n === null || n === 'invalid' ? null : n;
}

/** Online exactly while the newest accepted share is younger than the quiet interval. No share at all is offline. */
export function connectivityOf(lastShareAt: Date | null, now: Date, quietSeconds: number): Connectivity {
  if (lastShareAt === null) return 'offline';
  return now.getTime() - lastShareAt.getTime() < quietSeconds * 1000 ? 'online' : 'offline';
}

/**
 * The change to record for one worker, or null. A worker in maintenance, or one with no accepted share, records none.
 * A worker with no recorded change started online with its first share.
 */
export function transitionOf(input: {
  readonly lastShareAt: Date | null;
  readonly now: Date;
  readonly quietSeconds: number;
  readonly maintenance: boolean;
  readonly latest: Connectivity | null;
}): { from: Connectivity; to: Connectivity } | null {
  if (input.maintenance || input.lastShareAt === null) return null;
  const current = connectivityOf(input.lastShareAt, input.now, input.quietSeconds);
  const previous = input.latest ?? 'online';
  return current === previous ? null : { from: previous, to: current };
}

export function stateChangeKey(to: Connectivity, workerId: string, lastShareAt: Date): string {
  return `mining:worker-${to}:${workerId}:${lastShareAt.toISOString()}`;
}

export function maintenanceKey(workerId: string): string {
  return `mining:maintenance:${workerId}`;
}

/** `bps` of a whole weight as an exact decimal string (four places at most), never a JS number. */
export function shareOfWeight(weight: bigint, bps: number): string {
  const scaled = weight * BigInt(bps);
  const whole = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** A stored numeric as a canonical decimal string: no trailing zero places. */
export function canonicalDecimal(raw: string): string {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new MiningError('Stored limit is not a decimal', 'mining.amount_not_decimal');
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const kept = fraction.replace(/0+$/, '');
  const head = BigInt(whole).toString();
  return kept ? `${head}.${kept}` : head;
}

function connectivityRow(value: string | null): Connectivity | null {
  if (value === null) return null;
  if (value === 'online' || value === 'offline') return value;
  throw new MiningError('Recorded worker state is not online or offline', 'mining.worker_state_unknown');
}

export type WorkerOne = {
  readonly asOf: string;
  readonly id: string;
  readonly name: string;
  readonly windowMinutes: number;
  readonly hashing: 'hashing' | 'idle';
  readonly hashrate: string | null;
  readonly hashrateReason: typeof NO_SHARES | null;
  readonly connectivity: Connectivity;
  readonly lastShareAt: string | null;
  readonly state: WorkerState;
  readonly quietSeconds: number;
  readonly alertLimitMode: AlertLimitMode | null;
  readonly alertLimit: string | null;
  readonly alertLimitReason: typeof ALERT_LIMIT_UNSET | typeof NO_SHARES | null;
  readonly maintenanceSince: string | null;
};

export type StateChanges = {
  readonly asOf: string;
  readonly evaluatedAt: string | null;
  readonly rows: { workerId: string; from: Connectivity; to: Connectivity; at: string }[];
};

export type MaintenanceRows = { readonly asOf: string; readonly rows: { workerId: string; since: string }[] };

export type AlertLimitSetting = { readonly workerId: string; readonly mode: AlertLimitMode | null; readonly manualLimit: string | null };

type Observed = {
  id: string;
  user_id: string;
  last_share_at: Date | null;
  maintenance: boolean;
  latest: string | null;
  now: Date;
};

async function ownedWorker(sql: Sql, userId: string, workerId: string): Promise<{ id: string; name: string }> {
  const [row] = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM mining_pool.workers WHERE id = ${workerId} AND user_id = ${userId}
  `;
  if (!row) throw new MiningError('Worker not found', WORKER_NOT_FOUND);
  return row;
}

/**
 * Looks at one worker (or every worker when `workerId` is null) and records any change from its last recorded state.
 * Safe to run twice at once: each change has one business key and the insert does nothing on a conflict; a worker put
 * in maintenance after the look gets no row either. `markEvaluated` stamps the evaluator's look on every worker it saw,
 * maintenance ones included. Returns how many rows it wrote.
 */
export async function settleWorkers(
  sql: Sql,
  quietSeconds: number,
  workerId: string | null,
  markEvaluated: boolean,
): Promise<{ looked: number; recorded: number }> {
  const observed = await sql<Observed[]>`
    SELECT w.id, w.user_id,
           (SELECT max(s.created_at) FROM mining_pool.shares s WHERE s.worker_id = w.id AND s.weight IS NOT NULL) AS last_share_at,
           EXISTS (SELECT 1 FROM mining_pool.worker_maintenance m WHERE m.worker_id = w.id) AS maintenance,
           (SELECT c.to_state FROM mining_pool.worker_state_changes c WHERE c.worker_id = w.id ORDER BY c.seq DESC LIMIT 1) AS latest,
           now() AS now
    FROM mining_pool.workers w
    WHERE (${workerId}::text IS NULL OR w.id = ${workerId})
  `;
  let recorded = 0;
  for (const row of observed) {
    const change = transitionOf({
      lastShareAt: row.last_share_at,
      now: row.now,
      quietSeconds,
      maintenance: row.maintenance,
      latest: connectivityRow(row.latest),
    });
    if (!change || !row.last_share_at) continue;
    const written = await sql`
      INSERT INTO mining_pool.worker_state_changes (key, worker_id, user_id, from_state, to_state, last_share_at)
      SELECT ${stateChangeKey(change.to, row.id, row.last_share_at)}, ${row.id}, ${row.user_id}, ${change.from}, ${change.to},
             ${row.last_share_at}
      WHERE NOT EXISTS (SELECT 1 FROM mining_pool.worker_maintenance m WHERE m.worker_id = ${row.id})
      ON CONFLICT (key) DO NOTHING
    `;
    recorded += written.count;
  }
  if (markEvaluated && observed.length > 0) {
    await sql`
      INSERT INTO mining_pool.worker_evaluations (worker_id, evaluated_at)
      SELECT id, now() FROM unnest(${sql.array(observed.map((row) => row.id))}::text[]) AS id
      ON CONFLICT (worker_id) DO UPDATE SET evaluated_at = GREATEST(mining_pool.worker_evaluations.evaluated_at, EXCLUDED.evaluated_at)
    `;
  }
  return { looked: observed.length, recorded };
}

/** One of the caller's own workers: hashing in the window, connectivity, state, quiet interval and alert limit. */
export async function workerOne(
  sql: Sql,
  userId: string,
  workerId: string,
  windowMinutes: number,
  timing: { readonly quietSeconds: number; readonly alertShareBps: number | null },
): Promise<WorkerOne> {
  const worker = await ownedWorker(sql, userId, workerId);
  const [row] = await sql<
    {
      last_share_at: Date | null;
      weight: string | null;
      since: Date | null;
      mode: string | null;
      manual_limit: string | null;
      now: Date;
    }[]
  >`
    SELECT
      (SELECT max(s.created_at) FROM mining_pool.shares s WHERE s.worker_id = ${worker.id} AND s.weight IS NOT NULL) AS last_share_at,
      (SELECT SUM(s.weight)::text FROM mining_pool.shares s
         WHERE s.worker_id = ${worker.id} AND s.weight IS NOT NULL
           AND s.created_at >= now() - (${windowMinutes}::int * interval '1 minute')) AS weight,
      (SELECT m.since FROM mining_pool.worker_maintenance m WHERE m.worker_id = ${worker.id}) AS since,
      (SELECT a.mode FROM mining_pool.worker_alert_limits a WHERE a.worker_id = ${worker.id}) AS mode,
      (SELECT a.manual_limit::text FROM mining_pool.worker_alert_limits a WHERE a.worker_id = ${worker.id}) AS manual_limit,
      now() AS now
  `;
  if (!row) throw new MiningError('Worker not found', WORKER_NOT_FOUND);
  const hashrate = row.weight === null ? null : canonicalWeight(row.weight);
  const connectivity = connectivityOf(row.last_share_at, row.now, timing.quietSeconds);
  const mode = row.mode === 'automatic' || row.mode === 'manual' ? row.mode : null;
  let alertLimit: string | null = null;
  let alertLimitReason: WorkerOne['alertLimitReason'] = null;
  if (mode === 'manual' && row.manual_limit !== null) alertLimit = canonicalDecimal(row.manual_limit);
  else if (mode === 'automatic' && timing.alertShareBps !== null) {
    if (hashrate === null) alertLimitReason = NO_SHARES;
    else alertLimit = shareOfWeight(BigInt(hashrate), timing.alertShareBps);
  } else alertLimitReason = ALERT_LIMIT_UNSET;
  return {
    asOf: row.now.toISOString(),
    id: worker.id,
    name: worker.name,
    windowMinutes,
    hashing: hashrate === null ? 'idle' : 'hashing',
    hashrate,
    hashrateReason: hashrate === null ? NO_SHARES : null,
    connectivity,
    lastShareAt: row.last_share_at ? row.last_share_at.toISOString() : null,
    state: row.since ? 'maintenance' : connectivity === 'online' ? 'active' : 'offline',
    quietSeconds: timing.quietSeconds,
    alertLimitMode: mode,
    alertLimit,
    alertLimitReason,
    maintenanceSince: row.since ? row.since.toISOString() : null,
  };
}

/**
 * The recorded state changes of one of the caller's own workers, newest first, and when the evaluator last looked at it.
 * A read writes nothing: only the evaluator records a change, so a row appears at its next pass after the quiet interval.
 */
export async function workerStateChanges(sql: Sql, userId: string, workerId: string): Promise<StateChanges> {
  const worker = await ownedWorker(sql, userId, workerId);
  const rows = await sql<{ worker_id: string; from_state: string; to_state: string; at: Date }[]>`
    SELECT worker_id, from_state, to_state, at
    FROM mining_pool.worker_state_changes
    WHERE worker_id = ${worker.id}
    ORDER BY seq DESC
    LIMIT ${STATE_CHANGES_SHOWN}
  `;
  const [seen] = await sql<{ evaluated_at: Date | null; now: Date }[]>`
    SELECT (SELECT evaluated_at FROM mining_pool.worker_evaluations WHERE worker_id = ${worker.id}) AS evaluated_at, now() AS now
  `;
  return {
    asOf: (seen?.now ?? new Date()).toISOString(),
    evaluatedAt: seen?.evaluated_at ? seen.evaluated_at.toISOString() : null,
    rows: rows.map((row) => ({
      workerId: row.worker_id,
      from: connectivityRow(row.from_state) ?? 'online',
      to: connectivityRow(row.to_state) ?? 'offline',
      at: row.at.toISOString(),
    })),
  };
}

/** The caller's workers in maintenance, oldest first. */
export async function maintenanceOf(sql: Sql, userId: string, workerIds: readonly string[] | null = null): Promise<MaintenanceRows> {
  const rows = await sql<{ worker_id: string; since: Date; now: Date }[]>`
    SELECT worker_id, since, now() AS now
    FROM mining_pool.worker_maintenance
    WHERE user_id = ${userId}
      AND (${workerIds === null}::boolean OR worker_id = ANY(${sql.array([...(workerIds ?? [])])}::text[]))
    ORDER BY since ASC, worker_id ASC
  `;
  return {
    asOf: (rows[0]?.now ?? new Date()).toISOString(),
    rows: rows.map((row) => ({ workerId: row.worker_id, since: row.since.toISOString() })),
  };
}

/**
 * Puts the caller's own workers in maintenance (`on`) or takes them out. Any id that is not the caller's refuses the
 * whole call, before anything is written. On is one row per worker keyed `mining:maintenance:<workerId>`; asking again
 * keeps the first `since`. Off removes the rows. Returns the listed workers still in maintenance.
 */
export async function setMaintenance(sql: Sql, userId: string, workerIds: readonly string[], on: boolean): Promise<MaintenanceRows> {
  const ids = [...new Set(workerIds)];
  if (ids.length === 0 || ids.length > MAINTENANCE_BATCH_MAX) {
    throw new MiningError('Choose 1 to 50 workers', 'mining.maintenance_batch_invalid');
  }
  await transaction(sql, async (tx) => {
    const owned = await tx<{ id: string }[]>`
      SELECT id FROM mining_pool.workers WHERE user_id = ${userId} AND id = ANY(${tx.array(ids)}::text[]) FOR UPDATE
    `;
    if (owned.length !== ids.length) throw new MiningError('Worker not found', WORKER_NOT_FOUND);
    if (on) {
      for (const id of ids) {
        await tx`
          INSERT INTO mining_pool.worker_maintenance (worker_id, user_id, key)
          VALUES (${id}, ${userId}, ${maintenanceKey(id)})
          ON CONFLICT (worker_id) DO NOTHING
        `;
      }
    } else {
      await tx`DELETE FROM mining_pool.worker_maintenance WHERE user_id = ${userId} AND worker_id = ANY(${tx.array(ids)}::text[])`;
    }
  });
  return maintenanceOf(sql, userId, ids);
}

/**
 * The account's own alert limit for one of its workers: automatic (the owner's share of the worker's trailing hashrate),
 * manual (the account's own value) or no choice (null, which clears it). Neither mode is a default.
 */
export async function setAlertLimit(
  sql: Sql,
  userId: string,
  workerId: string,
  mode: AlertLimitMode | null,
  limit: string | null,
): Promise<AlertLimitSetting> {
  if (mode === 'manual' && (limit === null || !ALERT_LIMIT.test(limit) || /^0(\.0+)?$/.test(limit))) {
    throw new MiningError('A manual alert limit is a decimal above zero', ALERT_LIMIT_INVALID);
  }
  if (mode !== 'manual' && limit !== null) throw new MiningError('Only a manual alert limit takes a value', ALERT_LIMIT_INVALID);
  const worker = await ownedWorker(sql, userId, workerId);
  if (mode === null) {
    await sql`DELETE FROM mining_pool.worker_alert_limits WHERE worker_id = ${worker.id} AND user_id = ${userId}`;
    return { workerId: worker.id, mode: null, manualLimit: null };
  }
  const [row] = await sql<{ mode: string; manual_limit: string | null }[]>`
    INSERT INTO mining_pool.worker_alert_limits (worker_id, user_id, mode, manual_limit)
    VALUES (${worker.id}, ${userId}, ${mode}, ${mode === 'manual' ? limit : null})
    ON CONFLICT (worker_id) DO UPDATE
      SET mode = EXCLUDED.mode, manual_limit = EXCLUDED.manual_limit, updated_at = now()
    RETURNING mode, manual_limit::text AS manual_limit
  `;
  return {
    workerId: worker.id,
    mode: row?.mode === 'manual' ? 'manual' : 'automatic',
    manualLimit: row?.manual_limit ? canonicalDecimal(row.manual_limit) : null,
  };
}

/** The roster's badge for each listed worker of the caller: maintenance always; active or offline only with a quiet interval. */
export async function rosterStates(
  sql: Sql,
  userId: string,
  workerIds: readonly string[],
  quietSeconds: number | null,
): Promise<Map<string, { state: WorkerState | null; lastShareAt: string | null }>> {
  const out = new Map<string, { state: WorkerState | null; lastShareAt: string | null }>();
  if (workerIds.length === 0) return out;
  const rows = await sql<{ id: string; last_share_at: Date | null; maintenance: boolean; now: Date }[]>`
    SELECT w.id,
           (SELECT max(s.created_at) FROM mining_pool.shares s WHERE s.worker_id = w.id AND s.weight IS NOT NULL) AS last_share_at,
           EXISTS (SELECT 1 FROM mining_pool.worker_maintenance m WHERE m.worker_id = w.id) AS maintenance,
           now() AS now
    FROM mining_pool.workers w
    WHERE w.user_id = ${userId} AND w.id = ANY(${sql.array([...workerIds])}::text[])
  `;
  for (const row of rows) {
    const state: WorkerState | null = row.maintenance
      ? 'maintenance'
      : quietSeconds === null
        ? null
        : connectivityOf(row.last_share_at, row.now, quietSeconds) === 'online'
          ? 'active'
          : 'offline';
    out.set(row.id, { state, lastShareAt: row.last_share_at ? row.last_share_at.toISOString() : null });
  }
  return out;
}
