import type { Sql } from 'postgres';
import { formatAmount } from '@intafaced/ledger-client';
import {
  computeFromSource,
  listProjectionKeys,
  listSourceKeys,
  readProjection,
  replaceProjection,
  type DayProjection,
  type MetricsKey,
} from './compute.js';

/**
 * THE PROJECTOR — keeps the metrics tables equal to a recompute from source.
 *
 * WHY THIS CANNOT DRIFT (the design choice, in one place).
 *   1. Triggers (migration 0056) write a row to `pay.metrics_dirty` in the SAME
 *      transaction as every relevant source write. A reader that can see the
 *      source row can see its mark; a rolled-back write leaves no mark.
 *   2. The refresher never adds or subtracts. For each marked merchant-day it
 *      recomputes the WHOLE day from source (`computeFromSource`) and replaces the
 *      projection rows, then deletes exactly the mark ids it read. A source write
 *      that commits while it is working has its own, newer mark, which survives
 *      and triggers another recompute. An old figure can therefore be late, never
 *      wrong, and lateness is reported as `lagSeconds`.
 *   3. A poller with a high-water mark over `payment_events.seq` was rejected:
 *      a bigserial hands out numbers before commit, so a row with a lower seq can
 *      become visible after a higher one and a high-water mark would skip it for
 *      good. An in-transaction incremental update was rejected because it would
 *      need edits inside payment-service.ts (not this module's) and every bug in
 *      it would be silent drift. Marks are insert-only, so concurrent payments of
 *      one merchant never queue behind a shared row lock.
 *   4. Two refreshers (two replicas) are safe: each key is recomputed under
 *      `pg_advisory_xact_lock(key)`, and the mark ids are read AFTER the lock is
 *      held, so a second worker finds the marks already gone.
 */

export interface RefreshResult {
  readonly processed: number;
  readonly failed: ReadonlyArray<{ key: MetricsKey; error: string }>;
  /** Merchant-days still marked dirty after this pass (includes failures). */
  readonly remaining: number;
}

export interface RebuildResult extends RefreshResult {
  readonly marked: number;
  readonly passes: number;
}

export type ReconcileDiffKind = 'missing' | 'extra' | 'mismatch';
export interface ReconcileDiff {
  readonly merchantId: string;
  readonly day: string;
  readonly table: 'merchant_day' | 'status' | 'link';
  /** asset code, payment status or link id. */
  readonly subKey: string;
  readonly kind: ReconcileDiffKind;
  /** What source says (null when `extra`). Amounts are decimal strings. */
  readonly expected: Record<string, string | number> | null;
  /** What the projection says (null when `missing`). */
  readonly actual: Record<string, string | number> | null;
}
export interface ReconcileReport {
  readonly checkedKeys: number;
  /** Keys with unprocessed marks: expected to differ until the refresher runs, so not compared. */
  readonly pendingKeys: number;
  readonly diffs: ReconcileDiff[];
}

const RECONCILE_BATCH = 200;
const MAX_REBUILD_PASSES = 1000;

const lockName = (k: MetricsKey) => `pay.metrics:${k.merchantId}:${k.day}`;

/** Flatten a projection into comparable `table|merchant|day|subKey -> fields` entries (bigints as strings). */
function flatten(
  p: DayProjection,
): Map<string, { table: ReconcileDiff['table']; key: MetricsKey; subKey: string; fields: Record<string, string | number> }> {
  const out = new Map<
    string,
    { table: ReconcileDiff['table']; key: MetricsKey; subKey: string; fields: Record<string, string | number> }
  >();
  const put = (table: ReconcileDiff['table'], key: MetricsKey, subKey: string, fields: Record<string, string | number>) =>
    out.set(`${table}|${key.merchantId}|${key.day}|${subKey}`, { table, key, subKey, fields });
  for (const r of p.days) {
    put('merchant_day', r, r.assetCode, {
      paymentsCreated: r.paymentsCreated,
      captured: formatAmount(r.captured),
      capturedCount: r.capturedCount,
      largestCaptured: formatAmount(r.largestCaptured),
      refunded: formatAmount(r.refunded),
      refundedCount: r.refundedCount,
      settleGross: formatAmount(r.settleGross),
      settleFees: formatAmount(r.settleFees),
      settleNet: formatAmount(r.settleNet),
      settleCount: r.settleCount,
      unsettledNet: formatAmount(r.unsettledNet),
    });
  }
  for (const r of p.statuses) put('status', r, r.status, { payments: r.payments });
  for (const r of p.links) put('link', r, r.linkId, { payments: r.payments });
  return out;
}

export function diffProjections(expected: DayProjection, actual: DayProjection): ReconcileDiff[] {
  const e = flatten(expected);
  const a = flatten(actual);
  const diffs: ReconcileDiff[] = [];
  for (const [id, x] of e) {
    const y = a.get(id);
    const base = { merchantId: x.key.merchantId, day: x.key.day, table: x.table, subKey: x.subKey };
    if (!y) diffs.push({ ...base, kind: 'missing', expected: x.fields, actual: null });
    else if (JSON.stringify(x.fields) !== JSON.stringify(y.fields))
      diffs.push({ ...base, kind: 'mismatch', expected: x.fields, actual: y.fields });
  }
  for (const [id, y] of a) {
    if (!e.has(id))
      diffs.push({
        merchantId: y.key.merchantId,
        day: y.key.day,
        table: y.table,
        subKey: y.subKey,
        kind: 'extra',
        expected: null,
        actual: y.fields,
      });
  }
  return diffs.sort((p, q) =>
    `${p.merchantId}|${p.day}|${p.table}|${p.subKey}`.localeCompare(`${q.merchantId}|${q.day}|${q.table}|${q.subKey}`),
  );
}

export class MetricsProjector {
  constructor(private readonly sql: Sql) {}

  /** Marks not yet processed, and how old the oldest is. `merchantId` scopes it to one merchant. */
  async pending(merchantId?: string): Promise<{ keys: number; oldestMarkedAt: Date | null; now: Date }> {
    const only = merchantId ? this.sql`WHERE merchant_id = ${merchantId}` : this.sql``;
    const [row] = await this.sql<Array<{ keys: string; oldest: Date | null; now: Date }>>`
      SELECT count(*)::text AS keys, min(oldest) AS oldest, now() AS now FROM (
        SELECT min(marked_at) AS oldest FROM pay.metrics_dirty ${only} GROUP BY merchant_id, day
      ) d`;
    return { keys: Number(row?.keys ?? 0), oldestMarkedAt: row?.oldest ?? null, now: row?.now ?? new Date() };
  }

  /** Recompute one merchant-day from source and drop the marks that were read. Returns false when another worker had already done it. */
  async refreshKey(key: MetricsKey): Promise<boolean> {
    return this.sql.begin(async (t) => {
      const tx = t as unknown as Sql;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockName(key)}, 0))`;
      const marks = await tx<Array<{ id: string }>>`
        SELECT id::text AS id FROM pay.metrics_dirty WHERE merchant_id = ${key.merchantId} AND day = ${key.day}::date`;
      if (marks.length === 0) return false;
      const next = await computeFromSource(tx, [key]);
      await replaceProjection(tx, key, next);
      await tx`DELETE FROM pay.metrics_dirty WHERE id = ANY(${tx.array(marks.map((m) => m.id))}::bigint[])`;
      return true;
    }) as Promise<boolean>;
  }

  /** Process up to `maxKeys` marked merchant-days, oldest mark first. A key that fails stays marked; the pass continues. */
  async refreshPending(options: { maxKeys?: number } = {}): Promise<RefreshResult> {
    const maxKeys = options.maxKeys ?? 500;
    const keys = await this.sql<Array<{ merchant_id: string; day: string }>>`
      SELECT merchant_id, day::text AS day FROM pay.metrics_dirty
       GROUP BY merchant_id, day ORDER BY min(id) LIMIT ${maxKeys}`;
    let processed = 0;
    const failed: Array<{ key: MetricsKey; error: string }> = [];
    for (const row of keys) {
      const key = { merchantId: row.merchant_id, day: row.day };
      try {
        if (await this.refreshKey(key)) processed += 1;
      } catch (err) {
        failed.push({ key, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { processed, failed, remaining: (await this.pending()).keys };
  }

  /** Drain every mark. Stops early only if a key keeps failing (poison) so one bad day cannot spin the loop. */
  async drain(): Promise<RefreshResult> {
    let processed = 0;
    let failed: RefreshResult['failed'] = [];
    for (let pass = 0; pass < MAX_REBUILD_PASSES; pass += 1) {
      const r = await this.refreshPending({ maxKeys: 500 });
      processed += r.processed;
      failed = r.failed;
      if (r.remaining === 0 || r.failed.length > 0 || r.processed === 0) return { processed, failed, remaining: r.remaining };
    }
    return { processed, failed, remaining: (await this.pending()).keys };
  }

  /**
   * REBUILD FROM SOURCE. Marks every merchant-day that source or the projection
   * knows about, then drains. With `clear: true` the projection tables are emptied
   * first, in the same transaction as the marking, so a reader sees either the old
   * rows or an empty projection WITH a lag (never an empty one that claims to be fresh).
   */
  async rebuild(options: { clear?: boolean; merchantId?: string } = {}): Promise<RebuildResult> {
    const { merchantId } = options;
    const marked = await this.sql.begin(async (t) => {
      const tx = t as unknown as Sql;
      const keys = new Map<string, MetricsKey>();
      for (const k of [...(await listSourceKeys(tx, merchantId)), ...(await listProjectionKeys(tx, merchantId))])
        keys.set(`${k.merchantId}|${k.day}`, k);
      if (options.clear) {
        const only = merchantId ? tx`WHERE merchant_id = ${merchantId}` : tx``;
        await tx`DELETE FROM pay.metrics_merchant_day_link ${only}`;
        await tx`DELETE FROM pay.metrics_merchant_day_status ${only}`;
        await tx`DELETE FROM pay.metrics_merchant_day ${only}`;
      }
      const all = [...keys.values()];
      for (let i = 0; i < all.length; i += 1000) {
        const slice = all.slice(i, i + 1000);
        await tx`
          INSERT INTO pay.metrics_dirty (merchant_id, day)
          SELECT t.merchant_id, t.day FROM unnest(${tx.array(slice.map((k) => k.merchantId))}::uuid[], ${tx.array(slice.map((k) => k.day))}::date[]) AS t(merchant_id, day)`;
      }
      return all.length;
    });
    const drained = await this.drain();
    return { ...drained, marked: marked as number, passes: 1 };
  }

  /**
   * RECONCILE: compare the projection to a fresh recompute from source and return
   * every difference (zero tolerance, exact bigint equality). Runs in one
   * repeatable-read snapshot, so source, projection and marks are one consistent
   * state. Keys with unprocessed marks are skipped and counted as pending.
   */
  async reconcile(options: { merchantId?: string } = {}): Promise<ReconcileReport> {
    return (await this.sql.begin('isolation level repeatable read read only', async (t) => {
      const tx = t as unknown as Sql;
      const pendingRows = await tx<Array<{ merchant_id: string; day: string }>>`
        SELECT DISTINCT merchant_id, day::text AS day FROM pay.metrics_dirty
         ${options.merchantId ? tx`WHERE merchant_id = ${options.merchantId}` : tx``}`;
      const pending = new Set(pendingRows.map((r) => `${r.merchant_id}|${r.day}`));
      const keys = new Map<string, MetricsKey>();
      for (const k of [...(await listSourceKeys(tx, options.merchantId)), ...(await listProjectionKeys(tx, options.merchantId))]) {
        const id = `${k.merchantId}|${k.day}`;
        if (!pending.has(id)) keys.set(id, k);
      }
      const all = [...keys.values()];
      const diffs: ReconcileDiff[] = [];
      for (let i = 0; i < all.length; i += RECONCILE_BATCH) {
        const slice = all.slice(i, i + RECONCILE_BATCH);
        diffs.push(...diffProjections(await computeFromSource(tx, slice), await readProjection(tx, slice)));
      }
      return { checkedKeys: all.length, pendingKeys: pending.size, diffs } satisfies ReconcileReport;
    })) as ReconcileReport;
  }
}

/** Background loop for a service process. Overlapping passes are skipped; errors are reported, never thrown. */
export function startMetricsRefresher(
  projector: Pick<MetricsProjector, 'refreshPending'>,
  options: { intervalMs?: number; onError?: (err: unknown) => void; onFailedKeys?: (failed: RefreshResult['failed']) => void } = {},
): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    projector
      .refreshPending()
      .then((r) => {
        if (r.failed.length > 0) options.onFailedKeys?.(r.failed);
      })
      .catch((err: unknown) => options.onError?.(err))
      .finally(() => {
        running = false;
      });
  }, options.intervalMs ?? 5_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
