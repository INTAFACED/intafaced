/**
 * Fee tiers by 30-day volume (SP-fees-vip-03, J-cex-spot-10 #5-#6): the owner's tier programme, part of the versioned
 * fee schedule and written through the same two-person door.
 *
 * A tier is a volume read model, never a balance. Each daily snapshot counts a person's own spot fills over the 30
 * days before it, in the quote assets the owner names, one unit each, and writes the tier that volume reaches under the
 * business key `tier-snapshot:<instant>:<userId>`. An order takes the tier of the last finished snapshot when it is
 * placed and keeps it, as it keeps its schedule version. A tier changes at a snapshot, never mid-day.
 *
 * Everything the owner has not set stays blank and is said on the page: no programme means every account is regular
 * ("Thresholds not set"), no snapshot time means no snapshot runs. Rules this service cannot apply yet (an asset tier,
 * a downgrade grace period, sub-account or bot volume counting toward a tier) refuse at the write door instead of being
 * stored and ignored.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { FeeScheduleError, REGULAR_FEE_TIER, TRADE_FEE_SCHEDULE_ENV, type FeeScheduleRow } from './fee-schedule.js';

/** The tier a programme gives at `minVolume30d` or more, in counted quote units. */
export interface FeeTierThreshold {
  readonly tierId: string;
  /** Decimal string, above zero. */
  readonly minVolume30d: string;
}

export interface FeeTierProgram {
  /** Lowest threshold first; each tier above the one before. */
  readonly thresholds: readonly FeeTierThreshold[];
  /** Spot fills quoted in these assets count, one unit each. Others are excluded and the page says so. */
  readonly volumeQuotes: readonly string[];
  /** "HH:MM" UTC, once a day. Null: no snapshot runs; tiers stay at the last snapshot, regular for a new account. */
  readonly snapshotTimeUtc: string | null;
}

/** The days a snapshot looks back over. */
export const TIER_VOLUME_DAYS = 30;

const DAY_MS = 86_400_000;
const SNAPSHOT_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const ASSET = /^[A-Z0-9]{2,12}$/;

/** Rules the programme may name only as blank today; each refuses with the reason when set. */
const BLANK_ONLY = {
  downgradeGraceDays: 'a downgrade grace period is not applied yet: a downgrade takes effect at the next snapshot',
  subAccounts: 'sub-account volume does not count toward a main account yet',
  botsAndCopy: 'bot, algorithmic and copy trading volume does not count toward a tier yet',
} as const;

/**
 * `tierProgram` of a rows schedule, or null when the owner set none. Every threshold tier must be priced in every pair
 * group the schedule names, so a tier a snapshot gives never meets a market with no rate for it.
 */
export function parseTierProgram(raw: unknown, rows: readonly FeeScheduleRow[] | undefined): FeeTierProgram | null {
  if (raw === undefined || raw === null) return null;
  const blank = (message: string) => new FeeScheduleError(`${TRADE_FEE_SCHEDULE_ENV}.tierProgram${message}`, 'trade.fee_schedule_blank');
  if (typeof raw !== 'object' || Array.isArray(raw)) throw blank(' must be an object');
  if (!rows) throw blank(' needs a rows schedule: the flat schedule has no tiers');
  const obj = raw as Record<string, unknown>;
  for (const [key, why] of Object.entries(BLANK_ONLY)) {
    if (!(key in obj)) throw blank(`.${key} must be null (never absent)`);
    if (obj[key] !== null) throw blank(`.${key}: ${why}`);
  }

  if (!Array.isArray(obj.volumeQuotes) || obj.volumeQuotes.length === 0) throw blank('.volumeQuotes must name the quote assets that count');
  const volumeQuotes = obj.volumeQuotes.map((asset, index) => {
    if (typeof asset !== 'string' || !ASSET.test(asset)) throw blank(`.volumeQuotes[${index}] must be an asset code`);
    return asset;
  });
  if (new Set(volumeQuotes).size !== volumeQuotes.length) throw blank('.volumeQuotes repeats an asset');

  if (!('snapshotTimeUtc' in obj)) throw blank('.snapshotTimeUtc must be "HH:MM" or null (never absent)');
  if (obj.snapshotTimeUtc !== null && (typeof obj.snapshotTimeUtc !== 'string' || !SNAPSHOT_TIME.test(obj.snapshotTimeUtc))) {
    throw blank('.snapshotTimeUtc must be "HH:MM" UTC or null');
  }

  if (!Array.isArray(obj.thresholds) || obj.thresholds.length === 0) throw blank('.thresholds must be a non-empty array');
  const groups = [...new Set(rows.map((row) => row.pairGroup))];
  let below = 0n;
  const thresholds = obj.thresholds.map((entry, index): FeeTierThreshold => {
    const at = `.thresholds[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw blank(`${at} must be an object`);
    const row = entry as Record<string, unknown>;
    if ('minAssets' in row) throw blank(`${at}.minAssets: an asset tier is not counted yet; publish volume thresholds only`);
    if (typeof row.tierId !== 'string' || !row.tierId.trim()) throw blank(`${at}.tierId must be a non-empty string`);
    const tierId = row.tierId.trim();
    if (tierId === REGULAR_FEE_TIER) throw blank(`${at}: '${REGULAR_FEE_TIER}' is the tier below every threshold`);
    let min: bigint;
    try {
      if (typeof row.minVolume30d !== 'string') throw new Error('not a string');
      min = parseAmount(row.minVolume30d);
    } catch {
      throw blank(`${at}.minVolume30d must be a decimal string`);
    }
    if (min <= below) throw blank(`${at}.minVolume30d must be above zero and above the threshold before it`);
    below = min;
    const unpriced = groups.filter((group) => !rows.some((r) => r.pairGroup === group && r.tierId === tierId));
    if (unpriced.length > 0) throw blank(`${at}: tier '${tierId}' has no row in pair group ${unpriced.map((g) => `'${g}'`).join(', ')}`);
    return { tierId, minVolume30d: formatAmount(min) };
  });
  if (new Set(thresholds.map((t) => t.tierId)).size !== thresholds.length) throw blank('.thresholds repeats a tier');
  return { thresholds, volumeQuotes, snapshotTimeUtc: obj.snapshotTimeUtc as string | null };
}

/** The tier `volume` reaches: the highest threshold at or below it, else regular. */
export function tierForVolume(program: FeeTierProgram, volume: bigint): string {
  let tier: string = REGULAR_FEE_TIER;
  for (const threshold of program.thresholds) {
    if (volume >= parseAmount(threshold.minVolume30d)) tier = threshold.tierId;
  }
  return tier;
}

/** The next threshold above `volume` and how much more it needs, or null at the top tier. */
export function nextThreshold(program: FeeTierProgram, volume: bigint): { tierId: string; minVolume30d: string; remaining: string } | null {
  const next = program.thresholds.find((threshold) => parseAmount(threshold.minVolume30d) > volume);
  if (!next) return null;
  return { tierId: next.tierId, minVolume30d: next.minVolume30d, remaining: formatAmount(parseAmount(next.minVolume30d) - volume) };
}

function instantOn(day: number, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return new Date(day * DAY_MS + (hours * 60 + minutes) * 60_000);
}

/**
 * The latest snapshot instant at or before `now`, at the programme's time of day, and not before `since` (when the
 * programme came into force; null: before anything stored, no bound): a programme never snapshots a moment before it
 * existed.
 */
export function lastSnapshotInstant(program: FeeTierProgram, since: Date | null, now: Date): Date | null {
  if (program.snapshotTimeUtc === null) return null;
  const today = Math.floor(now.getTime() / DAY_MS);
  for (const day of [today, today - 1]) {
    const instant = instantOn(day, program.snapshotTimeUtc);
    if (instant.getTime() <= now.getTime()) return since === null || instant.getTime() >= since.getTime() ? instant : null;
  }
  return null;
}

/** The first snapshot instant after `now` (and not before `since`), or null with no snapshot time. */
export function nextSnapshotInstant(program: FeeTierProgram, since: Date | null, now: Date): Date | null {
  if (program.snapshotTimeUtc === null) return null;
  const from = Math.max(now.getTime() + 1, since?.getTime() ?? 0);
  const day = Math.floor(from / DAY_MS);
  for (const candidate of [day, day + 1]) {
    const instant = instantOn(candidate, program.snapshotTimeUtc);
    if (instant.getTime() >= from) return instant;
  }
  return null;
}

/** "2026-10-24T07:00Z": the minute of a snapshot, as its business key names it. */
export const snapshotMinute = (instant: Date): string => `${instant.toISOString().slice(0, 16)}Z`;

/** The business key of one account's row in one snapshot: a re-run of the snapshot writes nothing new. */
export const tierSnapshotKey = (instant: Date, userId: string): string => `tier-snapshot:${snapshotMinute(instant)}:${userId}`;

/** The window a snapshot at `instant` counts: the 30 days before it. */
export const volumeWindow = (instant: Date): { from: Date; to: Date } => ({
  from: new Date(instant.getTime() - TIER_VOLUME_DAYS * DAY_MS),
  to: instant,
});
