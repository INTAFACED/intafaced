import { transaction } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { PplnsInput } from './pplns.js';

export const EPOCH_UNSET = 'mining.epoch_unset';
export const EMISSION_UNPUBLISHED = 'mining.emission_unpublished';
export const PG_UNAVAILABLE = 'mining.pg_unavailable';
export const WINDOW_PAID = 'mining.window_paid';
export const WINDOW_CONFLICT = 'mining.window_conflict';
export const SHARE_DUPLICATE = 'mining.share_duplicate';
export const WORKER_NAME_INVALID = 'mining.worker_name_invalid';
/** The worker a share with no name goes to. */
export const DEFAULT_WORKER = 'default';
export const WORKER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A rig name as sent: absent is the default worker; anything outside letters, digits, dash and underscore is refused. */
export function workerNameOf(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_WORKER;
  if (typeof value !== 'string' || !WORKER_NAME.test(value)) throw new Error(WORKER_NAME_INVALID);
  return value;
}

/** One worker per account and name. The name has no colon, so two different (account, name) pairs never share an id. */
export function workerIdOf(minerId: string, name: string): string {
  return `worker:${minerId}:${name}`;
}

export type BlankRewardShare = {
  readonly shareId: string;
  readonly minerId: string;
  readonly weight: bigint | null;
  readonly workerName?: string;
  /** The checked proof-of-work nonce. One nonce counts once per worker and window: the same work again is a duplicate. */
  readonly powNonce?: string;
  /** Checked under a testnet proof-of-work set: its window earns no credit. */
  readonly testnet?: boolean;
};
type StoredWindowInput = {
  readonly windowId: string;
  readonly assetId: string;
  readonly epoch: number | null;
  readonly reward: string | null;
  readonly feeBps: number | null;
  readonly shares: readonly BlankRewardShare[];
};

/** Epoch is immutable, including null. Never infer it from a window ID. */
export async function readStoredEpoch(sql: Sql, windowId: string): Promise<number | null> {
  const [row] = await sql<{ epoch: number | null }[]>`SELECT epoch FROM mining_pool.windows WHERE window_id = ${windowId}`;
  if (!row) throw new Error(PG_UNAVAILABLE);
  if (row.epoch === null) return null;
  if (!Number.isInteger(row.epoch) || row.epoch < 0) throw new Error(EPOCH_UNSET);
  return row.epoch;
}

/** Rows per multi-row insert: eight columns a row stays far under Postgres's 65535 bind parameters. */
const INSERT_ROWS = 1000;
function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += INSERT_ROWS) out.push(rows.slice(at, at + INSERT_ROWS));
  return out;
}

/** Conflict checking and share appends hold the same window lock and transaction. */
async function persistShares(sql: Sql, input: StoredWindowInput): Promise<void> {
  if (!sql) throw new Error(PG_UNAVAILABLE);
  if (!input.windowId.trim() || !input.assetId.trim()) throw new Error('window_unconfigured');
  if (input.epoch !== null && (!Number.isInteger(input.epoch) || input.epoch < 0 || input.epoch > 2_147_483_647))
    throw new Error(EPOCH_UNSET);
  if (input.shares.length === 0) throw new Error('shares_empty');
  const named = input.shares.map((share) => {
    if (!share.shareId.trim() || !share.minerId.trim()) throw new Error('mining.share_malformed');
    if (share.weight !== null && (typeof share.weight !== 'bigint' || share.weight <= 0n || share.weight >= 10n ** 38n))
      throw new Error('mining.weight_not_integer');
    return { ...share, name: workerNameOf(share.workerName) };
  });
  // One row per (account, name), in one fixed order, so two batches that create the same workers take their locks in the
  // same order and never wait on each other in a cycle.
  const pairs = [...new Map(named.map((share) => [`${share.minerId}\n${share.name}`, share])).values()]
    .map((share) => ({ id: workerIdOf(share.minerId, share.name), user_id: share.minerId, name: share.name }))
    .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  await transaction(sql, async (tx) => {
    const written = await tx<{ window_id: string }[]>`
      INSERT INTO mining_pool.windows (window_id, epoch, asset_id, reward, fee_bps, status)
      VALUES (${input.windowId}, ${input.epoch}, ${input.assetId}, ${input.reward}, ${input.feeBps}, 'open')
      ON CONFLICT (window_id) DO UPDATE SET epoch = mining_pool.windows.epoch
      WHERE mining_pool.windows.status = 'open'
        AND mining_pool.windows.asset_id = EXCLUDED.asset_id
        AND mining_pool.windows.reward IS NOT DISTINCT FROM EXCLUDED.reward
        AND mining_pool.windows.fee_bps IS NOT DISTINCT FROM EXCLUDED.fee_bps
        AND mining_pool.windows.epoch IS NOT DISTINCT FROM EXCLUDED.epoch
      RETURNING window_id
    `;
    if (written.length === 0) {
      const [row] = await tx<{ status: string }[]>`SELECT status FROM mining_pool.windows WHERE window_id = ${input.windowId}`;
      if (!row) throw new Error(PG_UNAVAILABLE);
      if (row.status !== 'open') throw new Error(WINDOW_PAID);
      throw new Error(WINDOW_CONFLICT);
    }
    // The worker only labels the rig: miner_id stays the account the payout credits.
    for (const part of chunks(pairs)) {
      await tx`INSERT INTO mining_pool.workers ${tx(part, 'id', 'user_id', 'name')} ON CONFLICT DO NOTHING`;
    }
    // Locked in the same fixed order, so a mode change (workers.setMode) waits for this batch, or this batch for it:
    // a share is filed under the mode its worker has when it is stored.
    const workers = await tx<{ id: string; user_id: string; name: string; mode: string }[]>`
      SELECT w.id, w.user_id, w.name, w.mode
      FROM mining_pool.workers w
      JOIN unnest(${tx.array(pairs.map((pair) => pair.user_id))}::text[], ${tx.array(pairs.map((pair) => pair.name))}::text[])
        AS p(user_id, name) ON w.user_id = p.user_id AND w.name = p.name
      ORDER BY w.user_id, w.name
      FOR UPDATE OF w
    `;
    const workerOf = new Map(workers.map((row) => [`${row.user_id}\n${row.name}`, row]));
    const rows = named.map((share) => {
      const worker = workerOf.get(`${share.minerId}\n${share.name}`);
      if (!worker) throw new Error(PG_UNAVAILABLE);
      return {
        share_id: share.shareId,
        window_id: input.windowId,
        miner_id: share.minerId,
        weight: share.weight === null ? null : share.weight.toString(),
        worker_id: worker.id,
        pow_nonce: share.powNonce ?? null,
        // A solo worker's share is kept out of the pooled (PPLNS) split.
        solo: worker.mode === 'solo',
        testnet: share.testnet === true,
      };
    });
    // A share id already stored, or twice in this batch, refuses the whole batch, a byte-identical redelivery included:
    // one share, one worker. The same work (window, worker and nonce) under a new share id is the same duplicate.
    for (const part of chunks(rows)) {
      const inserted = await tx<{ share_id: string }[]>`
        INSERT INTO mining_pool.shares ${tx(part, 'share_id', 'window_id', 'miner_id', 'weight', 'worker_id', 'pow_nonce', 'solo', 'testnet')}
        ON CONFLICT DO NOTHING
        RETURNING share_id
      `;
      if (inserted.length !== part.length) throw new Error(SHARE_DUPLICATE);
    }
  });
}

/** No published reward or fee: persist empty slots, never invent payout terms. */
export async function persistBlankRewardShares(sql: Sql, input: Omit<StoredWindowInput, 'reward' | 'feeBps'>): Promise<void> {
  await persistShares(sql, { ...input, reward: null, feeBps: null });
}

export async function persistWindowShares(sql: Sql, input: PplnsInput): Promise<void> {
  parseAmount(input.reward);
  await persistShares(sql, { ...input, epoch: input.epoch ?? null });
}
