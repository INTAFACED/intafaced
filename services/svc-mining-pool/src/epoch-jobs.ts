import { transaction } from '@intafaced/db';
import type { LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { createJobHost, type JobHost } from './job-host.js';
import { postPayouts } from './ledger.js';
import { TESTNET_NO_CREDIT } from './pow.js';
import { stratumWindowEndsAt } from './stratum-door.js';
import { EMISSION_UNPUBLISHED, EPOCH_UNSET } from './window-store.js';

export const MINING_EPOCH_PAYOUT_JOB = 'mining.epoch_payout';
/** A window whose shares are all solo work: there is no pooled split to pay, whatever is published. */
export const NO_POOLED_SHARES = 'mining.no_pooled_shares';

type WindowRow = {
  window_id: string;
  epoch: number | null;
  asset_id: string;
  reward: string | null;
  fee_bps: number | null;
  status: string;
};

type ShareRow = { share_id: string; miner_id: string; weight: string | null; solo: boolean; testnet: boolean };

export interface MiningJobsDeps {
  sql: Sql;
  ledger: Pick<LedgerClient, 'post'>;
  intervalMs: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onError?: (name: string, err: unknown) => void;
}

export interface EpochPayoutTickResult {
  paid: string[];
  refused: string[];
}

/**
 * Pays one open window's pooled split, once.
 *
 * Work checked under a testnet proof-of-work set earns nothing. Each share is stamped testnet when it is stored, so the
 * rule reads the window's own shares, never today's settings: a window holding any testnet work is closed with no
 * credit (`no_credit`, nothing posted) and the call refuses `mining.testnet_no_credit`. Solo shares never join the
 * pooled split; their credit is refused on its own (`mining.emission_unpublished`, workers.soloCredit), so a paid window
 * credits its pooled shares only. A window of solo work alone refuses `mining.no_pooled_shares` and stays open.
 */
export async function payWindow(sql: Sql, ledger: Pick<LedgerClient, 'post'>, windowId: string): Promise<void> {
  const outcome = await transaction(sql, async (tx): Promise<'paid' | 'no_credit' | 'none'> => {
    const [window] = await tx<WindowRow[]>`
      SELECT window_id, epoch, asset_id, reward, fee_bps, status
      FROM mining_pool.windows
      WHERE window_id = ${windowId} AND status = 'open'
      FOR UPDATE
    `;
    if (!window) return 'none';
    const shares = await tx<ShareRow[]>`
      SELECT share_id, miner_id, weight, solo, testnet FROM mining_pool.shares WHERE window_id = ${window.window_id}
    `;
    if (shares.some((s) => s.testnet)) {
      await tx`UPDATE mining_pool.windows SET status = 'no_credit' WHERE window_id = ${window.window_id}`;
      return 'no_credit';
    }
    if (window.reward === null || window.fee_bps === null) throw new Error(EMISSION_UNPUBLISHED);
    const epoch = typeof window.epoch === 'number' ? window.epoch : window.epoch == null ? null : Number.parseInt(String(window.epoch), 10);
    if (epoch == null || !Number.isInteger(epoch) || epoch < 0) {
      throw new Error(EPOCH_UNSET);
    }
    const feeBps = typeof window.fee_bps === 'number' ? window.fee_bps : Number.parseInt(String(window.fee_bps), 10);
    if (!Number.isInteger(feeBps)) throw new Error('fee_unconfigured');
    const pooled = shares.filter((s) => !s.solo);
    if (shares.length > 0 && pooled.length === 0) throw new Error(NO_POOLED_SHARES);
    if (pooled.some((s) => s.weight === null)) throw new Error(EMISSION_UNPUBLISHED);
    await postPayouts(ledger, {
      windowId: window.window_id,
      epoch,
      assetId: window.asset_id,
      reward: window.reward,
      feeBps,
      shares: pooled.map((s) => {
        if (s.weight === null) throw new Error(EMISSION_UNPUBLISHED);
        return { shareId: s.share_id, minerId: s.miner_id, weight: BigInt(s.weight) };
      }),
    });
    await tx`UPDATE mining_pool.windows SET status = 'paid', paid_at = now() WHERE window_id = ${window.window_id}`;
    return 'paid';
  });
  if (outcome === 'no_credit') throw new Error(TESTNET_NO_CREDIT);
}

export async function runEpochPayoutTick(deps: {
  sql: Sql;
  ledger: Pick<LedgerClient, 'post'>;
  now?: () => number;
}): Promise<EpochPayoutTickResult> {
  const nowMs = (deps.now ?? Date.now)();
  // A miner-door window is paid only once its time is over: rigs are still mining in the current one.
  const open = (
    await deps.sql<{ window_id: string }[]>`
      SELECT window_id FROM mining_pool.windows WHERE status = 'open'
    `
  ).filter((row) => (stratumWindowEndsAt(row.window_id) ?? 0) <= nowMs);
  const paid: string[] = [];
  const refused: string[] = [];
  const refuseCodes = new Set<string>();
  for (const row of open) {
    try {
      await payWindow(deps.sql, deps.ledger, row.window_id);
      paid.push(row.window_id);
    } catch (err) {
      const code = err instanceof Error ? err.message : 'mining.payout_failed';
      if (code === EPOCH_UNSET || code === EMISSION_UNPUBLISHED || code === TESTNET_NO_CREDIT || code === NO_POOLED_SHARES) {
        refused.push(row.window_id);
        refuseCodes.add(code);
        continue;
      }
      throw err;
    }
  }
  if (refused.length > 0 && paid.length === 0) {
    throw new Error([TESTNET_NO_CREDIT, EMISSION_UNPUBLISHED, NO_POOLED_SHARES].find((code) => refuseCodes.has(code)) ?? EPOCH_UNSET);
  }
  return { paid, refused };
}

export function startMiningJobs(deps: MiningJobsDeps): { host: JobHost; stop(): void } {
  const host = createJobHost({
    onError: deps.onError,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });
  host.every(MINING_EPOCH_PAYOUT_JOB, deps.intervalMs, async () => {
    await runEpochPayoutTick(deps);
  });
  return {
    host,
    stop() {
      host.stopAll();
    },
  };
}
