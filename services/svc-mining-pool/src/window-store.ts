import { transaction } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { PplnsInput } from './pplns.js';

export const EPOCH_UNSET = 'mining.epoch_unset';
export const EMISSION_UNPUBLISHED = 'mining.emission_unpublished';
export const PG_UNAVAILABLE = 'mining.pg_unavailable';
export const WINDOW_PAID = 'mining.window_paid';
export const WINDOW_CONFLICT = 'mining.window_conflict';

export type BlankRewardShare = { readonly shareId: string; readonly minerId: string; readonly weight: bigint | null };
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
      await tx`
        INSERT INTO mining_pool.shares (share_id, window_id, miner_id, weight)
        VALUES (${share.shareId}, ${input.windowId}, ${share.minerId}, ${share.weight === null ? null : share.weight.toString()})
      `;
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
