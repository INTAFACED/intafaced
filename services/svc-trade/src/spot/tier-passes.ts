/**
 * VIP trial passes (CM-vip-tiers-01, J-campaigns-14 #2 to #4): a fee tier granted for a span of seconds as a campaign
 * reward. svc-campaigns grants one from a `trial_pass` campaign through `POST /internal/tier-pass`
 * (tier-pass-internal.ts), keyed `trial-pass:<campaignId>:<userId>`.
 *
 * A pass is in force from its start until it ends. While it is, an order is charged at the higher of the person's snapshot
 * tier and the pass's tier (`feeTierAt`), so the discount applies to the next fill. A later pass replaces the one in
 * force: the earlier ends at the later one's grant (`replaced`). A pass that runs its span ends at its end time
 * (`expired`), written by `endExpiredPasses` or by the first read after it. Either way `ended_at` is written once (a
 * trigger refuses a second write) and the badge goes. It moves no money: the fill posts its fee at the tier's rate.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';

export type TierPassEnd = 'expired' | 'replaced';

export interface TierPassRow {
  readonly passKey: string;
  readonly campaignId: string;
  readonly tierId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly grantedAt: string;
  /** When it ended and why; null while it has not. */
  readonly endedAt: string | null;
  readonly endReason: TierPassEnd | null;
  /** The pass that replaced it, when one did. */
  readonly replacedBy: string | null;
}

/** The longest pass, in seconds: a year, as the longest VIP trial. */
export const TIER_PASS_MAX_SECONDS = 366 * 86_400;
/** The shortest pass, in seconds. */
export const TIER_PASS_MIN_SECONDS = 60;

export const tierPassKey = (campaignId: string, userId: string): string => `trial-pass:${campaignId}:${userId}`;

interface DbRow {
  pass_key: string;
  campaign_id: string;
  tier_id: string;
  starts_at: Date;
  ends_at: Date;
  created_at: Date;
  ended_at: Date | null;
  end_reason: TierPassEnd | null;
  replaced_by: string | null;
}

const present = (row: DbRow): TierPassRow => ({
  passKey: row.pass_key,
  campaignId: row.campaign_id,
  tierId: row.tier_id,
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
  grantedAt: row.created_at.toISOString(),
  endedAt: row.ended_at?.toISOString() ?? null,
  endReason: row.end_reason,
  replacedBy: row.replaced_by,
});

const COLUMNS = 'pass_key, campaign_id, tier_id, starts_at, ends_at, created_at, ended_at, end_reason, replaced_by';

export interface GrantTierPass {
  readonly userId: string;
  readonly campaignId: string;
  readonly tierId: string;
  readonly seconds: number;
  readonly scheduleVersion: string;
  readonly grantedBy: string;
  readonly at: Date;
}

export interface GrantedTierPass {
  readonly pass: TierPassRow;
  /** False when this key was granted before: the pass as it was granted then, nothing written. */
  readonly granted: boolean;
  /** The pass this grant replaced, as it ended; null when none was in force. */
  readonly replaced: TierPassRow | null;
}

/**
 * Grants the pass keyed by campaign and person, once. A pass in force then ends `replaced` at `at`, in the same
 * transaction, so two passes are never in force together. Granting the same key again returns the pass it granted and
 * writes nothing.
 */
export async function grantTierPass(sql: Sql, input: GrantTierPass): Promise<GrantedTierPass> {
  const key = tierPassKey(input.campaignId, input.userId);
  const at = input.at.toISOString();
  const ends = new Date(input.at.getTime() + input.seconds * 1000).toISOString();
  return sql.begin(async (tx) => {
    // One grant per person at a time, so the replaced pass and the new one are decided together.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`tier-pass:${input.userId}`}, 0))`;
    const [existing] = await tx<DbRow[]>`SELECT ${tx.unsafe(COLUMNS)} FROM trade.tier_passes WHERE pass_key = ${key}`;
    if (existing) return { pass: present(existing), granted: false, replaced: null };
    const replaced = await tx<DbRow[]>`
      UPDATE trade.tier_passes
         SET ended_at = ${at}, end_reason = 'replaced', replaced_by = ${key}
       WHERE user_id = ${input.userId} AND ended_at IS NULL AND starts_at <= ${at} AND ends_at > ${at}
      RETURNING ${tx.unsafe(COLUMNS)}`;
    const [row] = await tx<DbRow[]>`
      INSERT INTO trade.tier_passes (id, pass_key, user_id, campaign_id, tier_id, starts_at, ends_at, schedule_version, granted_by, created_at)
      VALUES (${randomUUID()}, ${key}, ${input.userId}, ${input.campaignId}, ${input.tierId}, ${at}, ${ends},
              ${input.scheduleVersion}, ${input.grantedBy}, ${at})
      RETURNING ${tx.unsafe(COLUMNS)}`;
    return { pass: present(row!), granted: true, replaced: replaced[0] ? present(replaced[0]) : null };
  });
}

/** Ends, once, every pass whose span is over by `at` and that has not ended: `ended_at` is its end time. */
export async function endExpiredPasses(sql: Sql, at: Date, userId?: string): Promise<TierPassRow[]> {
  const rows = await sql<DbRow[]>`
    UPDATE trade.tier_passes
       SET ended_at = ends_at, end_reason = 'expired'
     WHERE ended_at IS NULL AND ends_at <= ${at.toISOString()} ${userId ? sql`AND user_id = ${userId}` : sql``}
    RETURNING ${sql.unsafe(COLUMNS)}`;
  return rows.map(present);
}

/** `userId`'s pass in force at `at` (started, not ended, its span not over), or null. */
export async function passInForce(sql: Sql, userId: string, at: Date): Promise<TierPassRow | null> {
  const [row] = await sql<DbRow[]>`
    SELECT ${sql.unsafe(COLUMNS)} FROM trade.tier_passes
     WHERE user_id = ${userId} AND starts_at <= ${at.toISOString()} AND ends_at > ${at.toISOString()}
       AND (ended_at IS NULL OR ended_at > ${at.toISOString()})
     ORDER BY starts_at DESC, pass_key
     LIMIT 1`;
  return row ? present(row) : null;
}

/** `userId`'s passes, newest grant first. */
export async function passesOf(sql: Sql, userId: string, limit: number): Promise<TierPassRow[]> {
  const rows = await sql<DbRow[]>`
    SELECT ${sql.unsafe(COLUMNS)} FROM trade.tier_passes WHERE user_id = ${userId}
     ORDER BY created_at DESC, pass_key LIMIT ${limit}`;
  return rows.map(present);
}
