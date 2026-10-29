import { transaction } from '@intafaced/db';
import type { LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { createJobHost, type JobHost } from './job-host.js';
import { postPayouts } from './ledger.js';
import { TESTNET_NO_CREDIT, powSpecBlank, readPowSpec } from './pow.js';
import { EMISSION_UNPUBLISHED, EPOCH_UNSET } from './window-store.js';

export const MINING_EPOCH_PAYOUT_JOB = 'mining.epoch_payout';

type WindowRow = {
  window_id: string;
  epoch: number | null;
  asset_id: string;
  reward: string | null;
  fee_bps: number | null;
  status: string;
};

type ShareRow = { share_id: string; miner_id: string; weight: string | null };

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
 * Shares checked under a testnet proof-of-work definition earn nothing: with testnet parameters published, every
 * payout refuses `mining.testnet_no_credit` before any post. Mainnet parameters refuse `audit.external` (`readPowSpec`).
 */
function refuseTestnetCredit(env: NodeJS.ProcessEnv): void {
  if (powSpecBlank(env)) return;
  if (readPowSpec(env).testnet) throw new Error(TESTNET_NO_CREDIT);
}

export async function payWindow(
  sql: Sql,
  ledger: Pick<LedgerClient, 'post'>,
  windowId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  refuseTestnetCredit(env);
  await transaction(sql, async (tx) => {
    const [window] = await tx<WindowRow[]>`
      SELECT window_id, epoch, asset_id, reward, fee_bps, status
      FROM mining_pool.windows
      WHERE window_id = ${windowId} AND status = 'open'
      FOR UPDATE
    `;
    if (!window) return;
    if (window.reward === null || window.fee_bps === null) throw new Error(EMISSION_UNPUBLISHED);
    const epoch = typeof window.epoch === 'number' ? window.epoch : window.epoch == null ? null : Number.parseInt(String(window.epoch), 10);
    if (epoch == null || !Number.isInteger(epoch) || epoch < 0) {
      throw new Error(EPOCH_UNSET);
    }
    const feeBps = typeof window.fee_bps === 'number' ? window.fee_bps : Number.parseInt(String(window.fee_bps), 10);
    if (!Number.isInteger(feeBps)) throw new Error('fee_unconfigured');
    const shares = await tx<ShareRow[]>`
      SELECT share_id, miner_id, weight FROM mining_pool.shares WHERE window_id = ${window.window_id} AND NOT solo
    `;
    // A window holding only solo work has no pooled split; solo credit waits for its reward source, as pooled credit does.
    if (shares.length === 0) throw new Error(EMISSION_UNPUBLISHED);
    if (shares.some((s) => s.weight === null)) throw new Error(EMISSION_UNPUBLISHED);
    await postPayouts(ledger, {
      windowId: window.window_id,
      epoch,
      assetId: window.asset_id,
      reward: window.reward,
      feeBps,
      shares: shares.map((s) => {
        if (s.weight === null) throw new Error(EMISSION_UNPUBLISHED);
        return { shareId: s.share_id, minerId: s.miner_id, weight: BigInt(s.weight) };
      }),
    });
    await tx`UPDATE mining_pool.windows SET status = 'paid', paid_at = now() WHERE window_id = ${window.window_id}`;
  });
}

export async function runEpochPayoutTick(deps: {
  sql: Sql;
  ledger: Pick<LedgerClient, 'post'>;
  env?: NodeJS.ProcessEnv;
}): Promise<EpochPayoutTickResult> {
  const open = await deps.sql<{ window_id: string }[]>`
    SELECT window_id FROM mining_pool.windows WHERE status = 'open'
  `;
  const paid: string[] = [];
  const refused: string[] = [];
  const refuseCodes = new Set<string>();
  for (const row of open) {
    try {
      await payWindow(deps.sql, deps.ledger, row.window_id, deps.env);
      paid.push(row.window_id);
    } catch (err) {
      const code = err instanceof Error ? err.message : 'mining.payout_failed';
      if (code === EPOCH_UNSET || code === EMISSION_UNPUBLISHED || code === TESTNET_NO_CREDIT) {
        refused.push(row.window_id);
        refuseCodes.add(code);
        continue;
      }
      throw err;
    }
  }
  if (refused.length > 0 && paid.length === 0) {
    throw new Error(
      refuseCodes.has(TESTNET_NO_CREDIT) ? TESTNET_NO_CREDIT : refuseCodes.has(EMISSION_UNPUBLISHED) ? EMISSION_UNPUBLISHED : EPOCH_UNSET,
    );
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
