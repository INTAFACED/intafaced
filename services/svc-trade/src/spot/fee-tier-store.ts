/**
 * Fee tier snapshots on Postgres (fee-tiers.ts): the counted 30-day volume, the daily snapshot run, and the tier an
 * order is placed at.
 *
 * Counted volume is a person's own spot fills, maker or taker, quoted in the programme's volume assets, summed at one
 * unit each. Fills of orders placed for them by a bot, an algorithm or copy trading are excluded while the owner's rule
 * for them is blank: svc-trade's own TWAP children (`algo:` client ids), execution children (`/client/` ids), copy
 * mirror orders (`trade.copy_placed_mirrors`) and copy flatten orders (`copy-flatten:` ids). A sub-account's fills are
 * its own and never its parent's. The house market maker is not an account with a tier. A fill that settles twice is
 * one row (the fill table's own sequence key), so it counts once.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { REGULAR_FEE_TIER, type OwnerFeeSchedule } from './fee-schedule.js';
import { tierForVolume, tierSnapshotKey, volumeWindow, type FeeTierProgram } from './fee-tiers.js';
import { HOUSE_MM_USER_UUID } from './ids.js';

/** Why each kind of volume is or is not counted, as the page says it. Codes, so the copy stays the screen's. */
export const VOLUME_EXCLUSIONS = ['other_quotes', 'futures_and_options', 'bots_and_copy', 'sub_accounts', 'assets'] as const;

export interface CountedVolume {
  /** Decimal string in counted quote units. */
  readonly volume: string;
  readonly fills: number;
}

export interface TierSnapshotRow {
  readonly key: string;
  readonly instant: string;
  readonly tierId: string;
  readonly volume30d: string;
  readonly countedFills: number;
  readonly scheduleVersion: string;
}

/** The fills a tier counts, as SQL over `trade.fills f` joined to its order `o` and market `m`. */
const countedFill = (sql: Sql, quotes: readonly string[]) => sql`
  m.kind = 'spot'
  AND m.quote_asset IN ${sql(quotes as string[])}
  AND f.user_id <> ${HOUSE_MM_USER_UUID}
  AND o.sub_account_id IS NULL
  AND NOT (coalesce(o.client_order_id, '') LIKE 'algo:%')
  AND NOT (coalesce(o.client_order_id, '') LIKE '%/client/%')
  AND NOT (coalesce(o.client_order_id, '') LIKE 'copy-flatten:%')
  AND NOT EXISTS (SELECT 1 FROM trade.copy_placed_mirrors cm WHERE cm.order_id = o.id::text)
`;

/** `userId`'s counted volume over `[from, to)`. */
export async function countedVolume(sql: Sql, program: FeeTierProgram, userId: string, from: Date, to: Date): Promise<CountedVolume> {
  const [row] = await sql<Array<{ volume: string | null; fills: number }>>`
    SELECT coalesce(sum(f.quote_amount), 0)::text AS volume, count(*)::int AS fills
      FROM trade.fills f
      JOIN trade.orders o ON o.id = f.order_id
      JOIN trade.markets m ON m.id = f.market_id
     WHERE f.user_id = ${userId}
       AND f.ts >= ${from.toISOString()} AND f.ts < ${to.toISOString()}
       AND ${countedFill(sql, program.volumeQuotes)}`;
  return { volume: formatAmount(parseAmount(row?.volume ?? '0')), fills: row?.fills ?? 0 };
}

/**
 * Write the snapshot at `instant`: one row per account with counted volume in its window, and one for each account a
 * previous snapshot left above regular (so a tier goes down when its volume does), then the run row that puts the
 * snapshot in force. Every row is keyed `tier-snapshot:<instant>:<userId>`, so a run that crashed half way and runs
 * again writes only the rows it had not, and a second run writes nothing. Answers the accounts in the snapshot.
 */
export async function runTierSnapshot(
  sql: Sql,
  program: FeeTierProgram,
  scheduleVersion: string,
  instant: Date,
): Promise<{ accounts: number; written: boolean }> {
  const [done] = await sql<
    Array<{ accounts: number }>
  >`SELECT accounts FROM trade.fee_tier_snapshot_runs WHERE instant = ${instant.toISOString()}`;
  if (done) return { accounts: done.accounts, written: false };
  const { from, to } = volumeWindow(instant);
  const volumes = await sql<Array<{ user_id: string; volume: string; fills: number }>>`
    SELECT f.user_id::text AS user_id, sum(f.quote_amount)::text AS volume, count(*)::int AS fills
      FROM trade.fills f
      JOIN trade.orders o ON o.id = f.order_id
      JOIN trade.markets m ON m.id = f.market_id
     WHERE f.ts >= ${from.toISOString()} AND f.ts < ${to.toISOString()}
       AND ${countedFill(sql, program.volumeQuotes)}
     GROUP BY f.user_id`;
  const above = await sql<Array<{ user_id: string }>>`
    SELECT user_id FROM (
      SELECT DISTINCT ON (s.user_id) s.user_id::text AS user_id, s.tier_id
        FROM trade.fee_tier_snapshots s
        JOIN trade.fee_tier_snapshot_runs r ON r.instant = s.instant
       WHERE s.instant < ${instant.toISOString()}
       ORDER BY s.user_id, s.instant DESC
    ) latest
     WHERE tier_id <> ${REGULAR_FEE_TIER}`;
  const figures = new Map(volumes.map((row) => [row.user_id, row]));
  for (const { user_id } of above) if (!figures.has(user_id)) figures.set(user_id, { user_id, volume: '0', fills: 0 });

  const rows = [...figures.values()].map((row) => {
    const volume = parseAmount(row.volume);
    return {
      key: tierSnapshotKey(instant, row.user_id),
      instant: instant.toISOString(),
      user_id: row.user_id,
      tier_id: tierForVolume(program, volume),
      volume_30d: formatAmount(volume),
      counted_fills: row.fills,
      schedule_version: scheduleVersion,
    };
  });
  await sql.begin(async (tx) => {
    for (let at = 0; at < rows.length; at += 500) {
      await tx`INSERT INTO trade.fee_tier_snapshots ${tx(rows.slice(at, at + 500))} ON CONFLICT (key) DO NOTHING`;
    }
    await tx`
      INSERT INTO trade.fee_tier_snapshot_runs (instant, schedule_version, accounts)
      VALUES (${instant.toISOString()}, ${scheduleVersion}, ${rows.length})
      ON CONFLICT (instant) DO NOTHING`;
  });
  return { accounts: rows.length, written: true };
}

/**
 * `userId`'s row in the last snapshot in force at `at` (its run finished by then), or null: a new account, or none
 * ran yet. An account with no row in that snapshot had no counted volume and was regular before it.
 */
export async function snapshotInForce(sql: Sql, userId: string, at: Date): Promise<TierSnapshotRow | null> {
  const [run] = await sql<Array<{ instant: Date }>>`
    SELECT instant FROM trade.fee_tier_snapshot_runs WHERE completed_at <= ${at.toISOString()} ORDER BY instant DESC LIMIT 1`;
  if (!run) return null;
  const [row] = await sql<SnapshotDbRow[]>`
    SELECT key, instant, tier_id, volume_30d::text AS volume_30d, counted_fills, schedule_version
      FROM trade.fee_tier_snapshots
     WHERE user_id = ${userId} AND instant = ${run.instant.toISOString()}`;
  return row ? present(row) : null;
}

/**
 * The tier an order `userId` places at `at` is charged at: the last snapshot's tier while the schedule in force has a
 * tier programme that still names it, else regular (no programme: "Thresholds not set").
 */
export async function feeTierAt(sql: Sql, schedule: OwnerFeeSchedule, userId: string, at: Date): Promise<string> {
  if (schedule.published !== true || !schedule.tierProgram) return REGULAR_FEE_TIER;
  const snapshot = await snapshotInForce(sql, userId, at);
  if (!snapshot) return REGULAR_FEE_TIER;
  return schedule.tierProgram.thresholds.some((threshold) => threshold.tierId === snapshot.tierId) ? snapshot.tierId : REGULAR_FEE_TIER;
}

interface SnapshotDbRow {
  key: string;
  instant: Date;
  tier_id: string;
  volume_30d: string;
  counted_fills: number;
  schedule_version: string;
}

const present = (row: SnapshotDbRow): TierSnapshotRow => ({
  key: row.key,
  instant: row.instant.toISOString(),
  tierId: row.tier_id,
  volume30d: formatAmount(parseAmount(row.volume_30d)),
  countedFills: row.counted_fills,
  scheduleVersion: row.schedule_version,
});

/** `userId`'s own snapshot rows from finished runs, newest first. */
export async function snapshotsOf(sql: Sql, userId: string, limit: number): Promise<TierSnapshotRow[]> {
  const rows = await sql<SnapshotDbRow[]>`
    SELECT s.key, s.instant, s.tier_id, s.volume_30d::text AS volume_30d, s.counted_fills, s.schedule_version
      FROM trade.fee_tier_snapshots s
      JOIN trade.fee_tier_snapshot_runs r ON r.instant = s.instant
     WHERE s.user_id = ${userId}
     ORDER BY s.instant DESC
     LIMIT ${limit}`;
  return rows.map(present);
}

/** The stored version in force at `at` and when it took effect, or null when the boot schedule is in force. */
export async function versionInForce(sql: Sql, at: Date): Promise<{ version: string; effectiveAt: Date } | null> {
  const [row] = await sql<Array<{ version: string; effective_at: Date }>>`
    SELECT version::text, effective_at FROM trade.fee_schedule_versions
     WHERE effective_at <= ${at.toISOString()}
     ORDER BY effective_at DESC, version DESC
     LIMIT 1`;
  return row ? { version: `v${row.version}`, effectiveAt: row.effective_at } : null;
}
