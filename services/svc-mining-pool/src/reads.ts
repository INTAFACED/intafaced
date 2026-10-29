import type { LedgerClient } from '@intafaced/ledger-client';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { canonicalMoney, canonicalWeight, weightToBigInt } from './decimal.js';
import { MiningError } from './errors.js';
import { decodeCursor, decodePayoutCursor, encodeCursor, encodePayoutCursor } from './list-limit.js';
import { miningPayoutIdempotencyKey } from './ledger.js';
import { planPplns } from './pplns.js';
import { workerIdOf } from './window-store.js';

const NO_SHARES = 'no_shares_in_window' as const;

function modeOf(raw: string): WorkerMode {
  if (raw === 'pooled' || raw === 'solo') return raw;
  throw new MiningError('Worker mode is not pooled or solo', 'mining.mode_invalid');
}

export type HashrateWorker = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly hashrate: string | null;
  readonly hashrateReason: typeof NO_SHARES | null;
  /** The account's own floor for this rig. Null is automatic: the pool picks. */
  readonly minDifficulty: string | null;
  /** Pooled shares join the PPLNS split; solo shares are kept out of it. */
  readonly mode: WorkerMode;
};

export type WorkerMode = 'pooled' | 'solo';
export const MODE_CHANGE_IN_WINDOW = 'mining.mode_change_in_window';

export type MyWorkers = {
  readonly asOf: string;
  readonly windowMinutes: number;
  readonly workers: HashrateWorker[];
  readonly nextCursor: string | null;
};

/** Optional page of the caller's roster. No limit is the whole roster; a name filter matches anywhere, ignoring case. */
export type WorkerQuery = { readonly limit?: number; readonly cursor?: string | null; readonly name?: string };

export type OpsWorker = { readonly id: string; readonly userId: string; readonly name: string; readonly createdAt: string };
export type WorkerPage = { readonly asOf: string; readonly workers: OpsWorker[]; readonly nextCursor: string | null };

export type ShareWindow = {
  readonly windowId: string;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  /** Of the accepted shares, those a solo rig sent: they stay out of the pooled split. */
  readonly soloCount: number;
  readonly acceptedWeight: string | null;
};
export type ShareReport = { readonly asOf: string; readonly windows: ShareWindow[] };

export type OpsWindow = {
  readonly windowId: string;
  readonly assetId: string;
  /** `no_credit`: a window of testnet work, closed with nothing paid. */
  readonly status: 'open' | 'paid' | 'no_credit';
  readonly reward: string | null;
  readonly feeBps: number | null;
  readonly shareCount: number;
  readonly totalWeight: string | null;
  readonly paidAt: string | null;
};
export type WindowReport = { readonly asOf: string; readonly windows: OpsWindow[] };

export type PendingEstimate = { readonly estimate: true; readonly estimatedGross: string };
export type PendingWindow = {
  readonly windowId: string;
  readonly assetId: string;
  readonly callerWeight: string;
  readonly totalWeight: string | null;
  readonly reward: string | null;
  readonly feeBps: number | null;
  readonly estimate: PendingEstimate | null;
};
export type PendingReport = { readonly asOf: string; readonly windows: PendingWindow[] };

export type PayoutCredit = {
  readonly windowId: string;
  readonly minerId: string;
  readonly assetId: string;
  readonly amount: string | null;
  readonly amountReason: string | null;
  readonly paidAt: string | null;
  readonly ledgerTransactionId: string | null;
  readonly ledgerReason: 'mining.ledger_unavailable' | 'mining.ledger_tx_unrecorded' | null;
};
export type PayoutPage = { readonly asOf: string; readonly payouts: PayoutCredit[]; readonly nextCursor: string | null };

export type ShareFilter = { readonly windowId?: string; readonly from?: string; readonly to?: string };

type LedgerLookup = Pick<LedgerClient, 'getTxByKey'>;

function asOfNow(): string {
  return new Date().toISOString();
}

function iso(value: Date | null): string | null {
  if (!value) return null;
  return value.toISOString();
}

function feeOf(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return Number(value);
  throw new MiningError('Stored fee is not an integer', 'fee_unconfigured');
}

function statusOf(value: string): 'open' | 'paid' | 'no_credit' {
  if (value === 'open' || value === 'paid' || value === 'no_credit') return value;
  throw new MiningError('Window status is not open, paid or no credit', 'mining.window_status_unknown');
}

function countOf(value: number | string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new MiningError('Share count is not an integer', 'mining.share_malformed');
}

function rangeInstant(value: string | undefined, label: string): Date | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) throw new MiningError(`${label} is blank`, 'mining.share_range_invalid');
  const at = new Date(trimmed);
  if (Number.isNaN(at.getTime())) throw new MiningError(`${label} is not a timestamp`, 'mining.share_range_invalid');
  return at;
}

export class MiningReadStore {
  constructor(
    private readonly sql: Sql | null,
    private readonly ledger: LedgerLookup | null,
  ) {}

  private db(): Sql {
    if (!this.sql) throw new MiningError('Postgres is not configured', 'mining.pg_unavailable');
    return this.sql;
  }

  private async callerMinerIds(userId: string): Promise<string[]> {
    const sql = this.db();
    const workers = await sql<{ id: string }[]>`SELECT id FROM mining_pool.workers WHERE user_id = ${userId}`;
    return [userId, ...workers.map((row) => row.id).filter((id) => id !== userId)];
  }

  async myWorkers(userId: string, windowMinutes: number, query: WorkerQuery = {}): Promise<MyWorkers> {
    const sql = this.db();
    const decoded = query.cursor ? decodeCursor(query.cursor) : null;
    const name = query.name?.trim() ? query.name.trim().toLowerCase() : null;
    const limit = query.limit ?? null;
    // The cursor carries the time to the millisecond (a JS Date), so the order and the comparison use the same
    // millisecond, and workers made in one batch (one now()) page by id instead of being skipped.
    const rows = await sql<{ id: string; name: string; created_at: Date; min_difficulty: string | null; mode: string }[]>`
      SELECT id, name, created_at, min_difficulty::text AS min_difficulty, mode
      FROM mining_pool.workers
      WHERE user_id = ${userId}
        AND (${name}::text IS NULL OR position(${name ?? ''} in lower(name)) > 0)
        AND (
          ${decoded?.at ?? null}::timestamptz IS NULL
          OR (date_trunc('milliseconds', created_at), id) < (${decoded?.at ?? null}::timestamptz, ${decoded?.key ?? ''})
        )
      ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC
      LIMIT ${limit === null ? null : limit + 1}
    `;
    const workers = limit === null ? rows : rows.slice(0, limit);
    const weights = new Map<string, string>();
    if (workers.length > 0) {
      // A share names its worker; a share stored before workers were labelled counts for the id it was sent under.
      const sums = await sql<{ worker: string; weight: string | null }[]>`
        SELECT COALESCE(worker_id, miner_id) AS worker, SUM(weight)::text AS weight
        FROM mining_pool.shares
        WHERE (
            worker_id = ANY(${sql.array(workers.map((worker) => worker.id))}::text[])
            OR (worker_id IS NULL AND miner_id = ANY(${sql.array(workers.map((worker) => worker.id))}::text[]))
          )
          AND weight IS NOT NULL
          AND created_at >= now() - (${windowMinutes}::int * interval '1 minute')
        GROUP BY COALESCE(worker_id, miner_id)
      `;
      for (const row of sums) {
        if (row.weight !== null) weights.set(row.worker, canonicalWeight(row.weight));
      }
    }
    const last = workers[workers.length - 1];
    return {
      asOf: asOfNow(),
      windowMinutes,
      workers: workers.map((worker) => {
        const hashrate = weights.get(worker.id) ?? null;
        return {
          id: worker.id,
          name: worker.name,
          createdAt: worker.created_at.toISOString(),
          hashrate,
          hashrateReason: hashrate === null ? NO_SHARES : null,
          minDifficulty: worker.min_difficulty === null ? null : canonicalWeight(worker.min_difficulty),
          mode: modeOf(worker.mode),
        };
      }),
      nextCursor: limit !== null && rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  /** Sets or clears (null: automatic) the floor on one of the caller's own workers. Another account's worker is not found. */
  async setWorkerDifficulty(
    userId: string,
    workerId: string,
    minDifficulty: bigint | null,
  ): Promise<{ id: string; minDifficulty: string | null }> {
    const sql = this.db();
    const [row] = await sql<{ id: string; min_difficulty: string | null }[]>`
      UPDATE mining_pool.workers
      SET min_difficulty = ${minDifficulty === null ? null : minDifficulty.toString()}
      WHERE id = ${workerId} AND user_id = ${userId}
      RETURNING id, min_difficulty::text AS min_difficulty
    `;
    if (!row) throw new MiningError('Worker not found', 'mining.worker_not_found');
    return { id: row.id, minDifficulty: row.min_difficulty === null ? null : canonicalWeight(row.min_difficulty) };
  }

  /**
   * Pooled or solo for one of the caller's own rigs, by name. A rig with no worker yet gets one under the caller's own
   * account. Saving the mode it already has changes nothing. A change is refused while the rig has a share in an open
   * window (`mining.mode_change_in_window`), so one window never holds a rig's work under two modes. The worker row is
   * locked first, the same lock share ingest takes, so no share can land between the check and the change.
   */
  async setWorkerMode(userId: string, name: string, mode: WorkerMode): Promise<{ id: string; name: string; mode: WorkerMode }> {
    const sql = this.db();
    const id = workerIdOf(userId, name);
    return transaction(sql, async (tx) => {
      await tx`INSERT INTO mining_pool.workers (id, user_id, name) VALUES (${id}, ${userId}, ${name}) ON CONFLICT DO NOTHING`;
      const [worker] = await tx<{ id: string; mode: string }[]>`
        SELECT id, mode FROM mining_pool.workers WHERE user_id = ${userId} AND name = ${name} FOR UPDATE
      `;
      if (!worker) throw new MiningError('Worker not found', 'mining.worker_not_found');
      if (worker.mode === mode) return { id: worker.id, name, mode };
      const [open] = await tx<{ n: number }[]>`
        SELECT 1 AS n
        FROM mining_pool.shares s
        JOIN mining_pool.windows w ON w.window_id = s.window_id
        WHERE s.worker_id = ${worker.id} AND w.status = 'open'
        LIMIT 1
      `;
      if (open) throw new MiningError('This rig has shares in an open window', MODE_CHANGE_IN_WINDOW);
      await tx`UPDATE mining_pool.workers SET mode = ${mode} WHERE id = ${worker.id}`;
      return { id: worker.id, name, mode };
    });
  }

  async listWorkers(limit: number, cursor: string | null): Promise<WorkerPage> {
    const sql = this.db();
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = await sql<{ id: string; user_id: string; name: string; created_at: Date }[]>`
      SELECT id, user_id, name, created_at
      FROM mining_pool.workers
      WHERE (
        ${decoded?.at ?? null}::timestamptz IS NULL
        OR (date_trunc('milliseconds', created_at), id) < (${decoded?.at ?? null}::timestamptz, ${decoded?.key ?? ''})
      )
      ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC
      LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      asOf: asOfNow(),
      workers: page.map((row) => ({
        id: row.id,
        userId: row.user_id,
        name: row.name,
        createdAt: row.created_at.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async shareReport(filter: ShareFilter, minerIds: readonly string[] | null): Promise<ShareReport> {
    const sql = this.db();
    const windowId = filter.windowId?.trim() ? filter.windowId.trim() : null;
    const from = rangeInstant(filter.from, 'from');
    const to = rangeInstant(filter.to, 'to');
    const restrict = minerIds !== null;
    const ids = minerIds ?? [''];
    const accepted = await sql<{ window_id: string; n: number | string; solo_n: number | string; weight: string | null }[]>`
      SELECT window_id, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE solo))::int AS solo_n, SUM(weight)::text AS weight
      FROM mining_pool.shares
      WHERE (${windowId}::text IS NULL OR window_id = ${windowId})
        AND (${from}::timestamptz IS NULL OR created_at >= ${from})
        AND (${to}::timestamptz IS NULL OR created_at < ${to})
        AND (${restrict}::boolean = false OR miner_id = ANY(${sql.array([...ids])}::text[]))
      GROUP BY window_id
    `;
    const rejected = await sql<{ window_id: string; n: number | string }[]>`
      SELECT window_id, COUNT(*)::int AS n
      FROM mining_pool.share_rejections
      WHERE (${windowId}::text IS NULL OR window_id = ${windowId})
        AND (${from}::timestamptz IS NULL OR created_at >= ${from})
        AND (${to}::timestamptz IS NULL OR created_at < ${to})
        AND (${restrict}::boolean = false OR miner_id = ANY(${sql.array([...ids])}::text[]))
      GROUP BY window_id
    `;
    const byWindow = new Map<string, ShareWindow>();
    for (const row of accepted) {
      byWindow.set(row.window_id, {
        windowId: row.window_id,
        acceptedCount: countOf(row.n),
        rejectedCount: 0,
        soloCount: countOf(row.solo_n),
        acceptedWeight: row.weight === null ? null : canonicalWeight(row.weight),
      });
    }
    for (const row of rejected) {
      const existing = byWindow.get(row.window_id);
      const rejectedCount = countOf(row.n);
      if (existing) byWindow.set(row.window_id, { ...existing, rejectedCount });
      else {
        byWindow.set(row.window_id, {
          windowId: row.window_id,
          acceptedCount: 0,
          rejectedCount,
          soloCount: 0,
          acceptedWeight: null,
        });
      }
    }
    return { asOf: asOfNow(), windows: [...byWindow.values()].sort((a, b) => (a.windowId < b.windowId ? -1 : 1)) };
  }

  async myShares(userId: string, filter: ShareFilter): Promise<ShareReport> {
    return this.shareReport(filter, await this.callerMinerIds(userId));
  }

  async opsShares(filter: ShareFilter): Promise<ShareReport> {
    return this.shareReport(filter, null);
  }

  async opsWindows(): Promise<WindowReport> {
    const sql = this.db();
    const rows = await sql<
      {
        window_id: string;
        asset_id: string;
        status: string;
        reward: string | null;
        fee_bps: number | string | null;
        share_count: number | string;
        total_weight: string | null;
        paid_at: Date | null;
      }[]
    >`
      SELECT w.window_id, w.asset_id, w.status, w.reward::text AS reward, w.fee_bps, w.paid_at,
             (SELECT COUNT(*)::int FROM mining_pool.shares s WHERE s.window_id = w.window_id AND NOT s.solo) AS share_count,
             (SELECT SUM(s.weight)::text FROM mining_pool.shares s WHERE s.window_id = w.window_id AND NOT s.solo) AS total_weight
      FROM mining_pool.windows w
      ORDER BY w.created_at DESC, w.window_id DESC
    `;
    return {
      asOf: asOfNow(),
      windows: rows.map((row) => ({
        windowId: row.window_id,
        assetId: row.asset_id,
        status: statusOf(row.status),
        reward: row.reward === null ? null : canonicalMoney(row.reward),
        feeBps: feeOf(row.fee_bps),
        shareCount: countOf(row.share_count),
        totalWeight: row.total_weight === null ? null : canonicalWeight(row.total_weight),
        paidAt: iso(row.paid_at),
      })),
    };
  }

  async pending(userId: string): Promise<PendingReport> {
    const sql = this.db();
    const minerIds = await this.callerMinerIds(userId);
    const windows = await sql<{ window_id: string; asset_id: string; reward: string | null; fee_bps: number | string | null }[]>`
      SELECT window_id, asset_id, reward::text AS reward, fee_bps
      FROM mining_pool.windows
      WHERE status = 'open'
      ORDER BY created_at ASC, window_id ASC
    `;
    if (windows.length === 0) return { asOf: asOfNow(), windows: [] };
    const ids = windows.map((row) => row.window_id);
    const sums = await sql<{ window_id: string; caller_weight: string | null; total_weight: string | null }[]>`
      SELECT window_id,
             SUM(weight) FILTER (WHERE miner_id = ANY(${sql.array(minerIds)}::text[]))::text AS caller_weight,
             SUM(weight)::text AS total_weight
      FROM mining_pool.shares
      WHERE window_id = ANY(${sql.array(ids)}::text[])
        AND weight IS NOT NULL
        AND NOT solo
      GROUP BY window_id
    `;
    const sumByWindow = new Map(sums.map((row) => [row.window_id, row]));
    const shareRows = await sql<{ window_id: string; share_id: string; miner_id: string; weight: string }[]>`
      SELECT window_id, share_id, miner_id, weight::text AS weight
      FROM mining_pool.shares
      WHERE window_id = ANY(${sql.array(ids)}::text[])
        AND weight IS NOT NULL
        AND NOT solo
    `;
    const sharesByWindow = new Map<string, { shareId: string; minerId: string; weight: bigint }[]>();
    for (const row of shareRows) {
      const list = sharesByWindow.get(row.window_id) ?? [];
      list.push({ shareId: row.share_id, minerId: row.miner_id, weight: weightToBigInt(row.weight) });
      sharesByWindow.set(row.window_id, list);
    }
    const caller = new Set(minerIds);
    return {
      asOf: asOfNow(),
      windows: windows.map((row) => {
        const sum = sumByWindow.get(row.window_id);
        const reward = row.reward === null ? null : canonicalMoney(row.reward);
        const feeBps = feeOf(row.fee_bps);
        const shares = sharesByWindow.get(row.window_id) ?? [];
        let estimate: PendingEstimate | null = null;
        if (reward !== null && feeBps !== null && shares.length > 0) {
          const plan = planPplns({ windowId: row.window_id, assetId: row.asset_id, reward, feeBps, shares });
          const mine = plan.payouts.filter((payout) => caller.has(payout.minerId));
          if (mine.length === 1) estimate = { estimate: true, estimatedGross: mine[0]!.amount };
          else if (mine.length > 1) {
            const total = mine.reduce((sumWeights, payout) => sumWeights + parseAmount(payout.amount), 0n);
            if (total > 0n) estimate = { estimate: true, estimatedGross: formatAmount(total) };
          }
        }
        return {
          windowId: row.window_id,
          assetId: row.asset_id,
          callerWeight: sum?.caller_weight ? canonicalWeight(sum.caller_weight) : '0',
          totalWeight: sum?.total_weight ? canonicalWeight(sum.total_weight) : null,
          reward,
          feeBps,
          estimate,
        };
      }),
    };
  }

  async myPayouts(userId: string, limit: number, cursor: string | null): Promise<PayoutPage> {
    const sql = this.db();
    const minerIds = await this.callerMinerIds(userId);
    const decoded = cursor ? decodePayoutCursor(cursor) : null;
    const rows = await sql<{ window_id: string; miner_id: string; paid_at: Date }[]>`
      SELECT w.window_id, s.miner_id, w.paid_at
      FROM mining_pool.shares s
      JOIN mining_pool.windows w ON w.window_id = s.window_id
      WHERE w.status = 'paid'
        AND w.paid_at IS NOT NULL
        AND s.weight IS NOT NULL
        AND NOT s.solo
        AND s.miner_id = ANY(${sql.array(minerIds)}::text[])
        AND (
          ${decoded?.at ?? null}::timestamptz IS NULL
          OR (w.paid_at, w.window_id, s.miner_id) < (
            ${decoded?.at ?? null}::timestamptz,
            ${decoded?.windowId ?? ''},
            ${decoded?.minerId ?? ''}
          )
        )
      GROUP BY w.window_id, s.miner_id, w.paid_at
      ORDER BY w.paid_at DESC, w.window_id DESC, s.miner_id DESC
      LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    const windowIds = [...new Set(page.map((row) => row.window_id))];
    const credits = windowIds.length === 0 ? [] : await this.creditsFor(page, windowIds);
    const last = page[page.length - 1];
    return {
      asOf: asOfNow(),
      payouts: credits,
      nextCursor: rows.length > limit && last ? encodePayoutCursor(last.paid_at, last.window_id, last.miner_id) : null,
    };
  }

  private async creditsFor(
    page: readonly { window_id: string; miner_id: string; paid_at: Date }[],
    windowIds: readonly string[],
  ): Promise<PayoutCredit[]> {
    const sql = this.db();
    const windows = await sql<
      { window_id: string; asset_id: string; reward: string | null; fee_bps: number | string | null; paid_at: Date | null }[]
    >`
      SELECT window_id, asset_id, reward::text AS reward, fee_bps, paid_at
      FROM mining_pool.windows
      WHERE window_id = ANY(${sql.array([...windowIds])}::text[])
    `;
    const byWindow = new Map(windows.map((row) => [row.window_id, row]));
    const shareRows = await sql<{ window_id: string; share_id: string; miner_id: string; weight: string }[]>`
      SELECT window_id, share_id, miner_id, weight::text AS weight
      FROM mining_pool.shares
      WHERE window_id = ANY(${sql.array([...windowIds])}::text[])
        AND weight IS NOT NULL
        AND NOT solo
    `;
    const sharesByWindow = new Map<string, { shareId: string; minerId: string; weight: bigint }[]>();
    for (const row of shareRows) {
      const list = sharesByWindow.get(row.window_id) ?? [];
      list.push({ shareId: row.share_id, minerId: row.miner_id, weight: weightToBigInt(row.weight) });
      sharesByWindow.set(row.window_id, list);
    }
    const out: PayoutCredit[] = [];
    for (const row of page) {
      const window = byWindow.get(row.window_id);
      if (!window) continue;
      const reward = window.reward === null ? null : canonicalMoney(window.reward);
      const feeBps = feeOf(window.fee_bps);
      const shares = sharesByWindow.get(row.window_id) ?? [];
      let amount: string | null = null;
      let amountReason: string | null = null;
      if (reward === null || feeBps === null) amountReason = 'mining.emission_unpublished';
      else if (shares.length === 0) amountReason = 'shares_empty';
      else {
        try {
          const plan = planPplns({ windowId: window.window_id, assetId: window.asset_id, reward, feeBps, shares });
          amount = plan.payouts.find((payout) => payout.minerId === row.miner_id)?.amount ?? null;
          if (amount === null) amountReason = 'mining.payout_rounded_to_zero';
        } catch (err) {
          amountReason = err instanceof Error ? err.message : 'mining.payout_failed';
        }
      }
      let ledgerTransactionId: string | null = null;
      let ledgerReason: PayoutCredit['ledgerReason'] = null;
      if (!this.ledger) ledgerReason = 'mining.ledger_unavailable';
      else {
        const tx = await this.ledger.getTxByKey(miningPayoutIdempotencyKey(row.window_id, row.miner_id));
        if (!tx) ledgerReason = 'mining.ledger_tx_unrecorded';
        else ledgerTransactionId = tx.id;
      }
      out.push({
        windowId: row.window_id,
        minerId: row.miner_id,
        assetId: window.asset_id,
        amount,
        amountReason,
        paidAt: iso(row.paid_at),
        ledgerTransactionId,
        ledgerReason,
      });
    }
    return out;
  }
}
