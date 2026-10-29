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
const WORKER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

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

/** Conflict checking and share appends hold the same window lock and transaction. */
async function persistShares(sql: Sql, input: StoredWindowInput): Promise<void> {
  if (!sql) throw new Error(PG_UNAVAILABLE);
  if (!input.windowId.trim() || !input.assetId.trim()) throw new Error('window_unconfigured');
  if (input.epoch !== null && (!Number.isInteger(input.epoch) || input.epoch < 0 || input.epoch > 2_147_483_647))
    throw new Error(EPOCH_UNSET);
  if (input.shares.length === 0) throw new Error('shares_empty');
  for (const share of input.shares) {
    if (!share.shareId.trim() || !share.minerId.trim()) throw new Error('mining.share_malformed');
    if (share.weight !== null && (typeof share.weight !== 'bigint' || share.weight <= 0n || share.weight >= 10n ** 38n))
      throw new Error('mining.weight_not_integer');
    workerNameOf(share.workerName);
  }
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
    for (const share of input.shares) {
      // The worker only labels the rig: miner_id stays the account the payout credits.
      const name = workerNameOf(share.workerName);
      await tx`
        INSERT INTO mining_pool.workers (id, user_id, name)
        VALUES (${workerIdOf(share.minerId, name)}, ${share.minerId}, ${name})
        ON CONFLICT DO NOTHING
      `;
      const [worker] = await tx<{ id: string }[]>`
        SELECT id FROM mining_pool.workers WHERE user_id = ${share.minerId} AND name = ${name}
      `;
      if (!worker) throw new Error(PG_UNAVAILABLE);
      // A share id already stored refuses the whole batch, a byte-identical redelivery included: one share, one worker.
      const inserted = await tx<{ share_id: string }[]>`
        INSERT INTO mining_pool.shares (share_id, window_id, miner_id, weight, worker_id)
        VALUES (${share.shareId}, ${input.windowId}, ${share.minerId}, ${share.weight === null ? null : share.weight.toString()}, ${worker.id})
        ON CONFLICT (share_id) DO NOTHING
        RETURNING share_id
      `;
      if (inserted.length === 0) throw new Error(SHARE_DUPLICATE);
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
