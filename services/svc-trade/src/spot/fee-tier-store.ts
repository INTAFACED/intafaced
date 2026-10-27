/**
 * Fee tier snapshots on Postgres (fee-tiers.ts): the counted 30-day volume, the daily snapshot run, and the tier an
 * order is placed at.
 *
 * Counted volume is a person's own spot fills, maker or taker, quoted in the programme's volume assets, summed at one
 * unit each, on live (not paper) markets. Whether an order's fills count is decided when it is placed and kept on the
 * row (`orders.tier_volume`): never for an order placed for the person by copy trading (mirrors and flattens), by an
 * algorithm (`algo:` client ids) or as an execution child (`/client/` ids) while the owner's rule for them is blank,
 * never for a sub-account's order (its fills are its own and never its parent's), and never for the house market maker,
 * which is not an account with a tier. A fill that settles twice is one row (the fill table's own sequence key), so it
 * counts once.
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

/**
 * Client ids of orders svc-trade places for a person: TWAP slices (`algo:<parent>:<slice>`) and execution children
 * (`.../client/...`). Copy mirrors and flattens are told by the path that places them (`copy.mirror`), since their
 * ids may be hashed.
 */
export function isPlacedForThem(clientOrderId: string | null | undefined): boolean {
  return clientOrderId != null && (clientOrderId.startsWith('algo:') || clientOrderId.includes('/client/'));
}

/** The fills a tier counts, as SQL over `trade.fills f` joined to its order `o` and market `m`. */
const countedFill = (sql: Sql, quotes: readonly string[]) => sql`
  o.tier_volume
  AND m.kind = 'spot'
  AND NOT m.paper
  AND m.quote_asset IN ${sql(quotes as string[])}
  AND f.user_id <> ${HOUSE_MM_USER_UUID}
  AND o.sub_account_id IS NULL
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
  // Every account the previous snapshot left above regular has a row in it (each snapshot writes one for every account
  // the one before left above regular), so that snapshot alone names who may step down.
  const above = await sql<Array<{ user_id: string }>>`
    SELECT s.user_id::text AS user_id
      FROM trade.fee_tier_snapshots s
     WHERE s.instant = (SELECT max(r.instant) FROM trade.fee_tier_snapshot_runs r WHERE r.instant < ${instant.toISOString()})
       AND s.tier_id <> ${REGULAR_FEE_TIER}`;
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

/** A VIP trial (vip-review.ts): a tier granted to one person for a span of days, whatever their volume. */
export interface VipTrialRow {
  readonly applicationId: string;
  readonly tierId: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

/** `userId`'s trials in force at `at` (started, not yet ended), the one ending last first. */
export async function trialsInForce(sql: Sql, userId: string, at: Date): Promise<VipTrialRow[]> {
  const rows = await sql<Array<{ application_id: string; tier_id: string; starts_at: Date; ends_at: Date }>>`
    SELECT application_id::text AS application_id, tier_id, starts_at, ends_at
      FROM trade.vip_trials
     WHERE user_id = ${userId} AND starts_at <= ${at.toISOString()} AND ends_at > ${at.toISOString()}
     ORDER BY ends_at DESC, application_id`;
  return rows.map((row) => ({
    applicationId: row.application_id,
    tierId: row.tier_id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
  }));
}

/**
 * The tier an order `userId` places at `at` is charged at: the higher of the last snapshot's tier and any VIP trial in
 * force, each while the schedule in force has a tier programme that still names it, else regular (no programme:
 * "Thresholds not set").
 */
export async function feeTierAt(sql: Sql, schedule: OwnerFeeSchedule, userId: string, at: Date): Promise<string> {
  if (schedule.published !== true || !schedule.tierProgram) return REGULAR_FEE_TIER;
  const [snapshot, trials] = await Promise.all([snapshotInForce(sql, userId, at), trialsInForce(sql, userId, at)]);
  return tierOf(schedule, snapshot, trials);
}

/**
 * The tier `snapshot` and `trials` give under `schedule`: the highest of them the programme in force still names (its
 * thresholds rise, so the later one is higher), else regular.
 */
export function tierOf(schedule: OwnerFeeSchedule, snapshot: TierSnapshotRow | null, trials: readonly VipTrialRow[] = []): string {
  if (schedule.published !== true || !schedule.tierProgram) return REGULAR_FEE_TIER;
  const order = schedule.tierProgram.thresholds.map((threshold) => threshold.tierId);
  const named = [snapshot?.tierId, ...trials.map((trial) => trial.tierId)].filter((tier): tier is string => !!tier && order.includes(tier));
  return named.reduce<string>((best, tier) => (order.indexOf(tier) > order.indexOf(best) ? tier : best), REGULAR_FEE_TIER);
}

/** The trial `tierOf` charged at, when it is one: the one ending last of those that gave `tier`, or null. */
export function trialGiving(tier: string, trials: readonly VipTrialRow[]): VipTrialRow | null {
  return trials.find((trial) => trial.tierId === tier) ?? null;
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

/**
 * Since when a tier programme has been in force without a break, at `at`: the time the earliest stored version took
 * effect in the unbroken run of versions with a programme that ends with the one in force. A version that only changes
 * rates keeps the run going, and so does a restart. Null when the run reaches back past every stored version to a boot
 * schedule that has a programme too: it has been in force since before anything this service stored, so no bound.
 * Versions are few (each one is a two-person approval), so they are read whole.
 */
export async function programmeSince(sql: Sql, boot: OwnerFeeSchedule, at: Date): Promise<Date | null> {
  const rows = await sql<Array<{ effective_at: Date; has_programme: boolean }>>`
    SELECT effective_at, coalesce(jsonb_typeof(schedule->'tierProgram') = 'object', false) AS has_programme
      FROM trade.fee_schedule_versions
     WHERE effective_at <= ${at.toISOString()}
     ORDER BY effective_at DESC, version DESC`;
  let since: Date | null = null;
  for (const row of rows) {
    if (!row.has_programme) return since;
    since = row.effective_at;
  }
  return boot.published === true && boot.tierProgram ? null : since;
}
