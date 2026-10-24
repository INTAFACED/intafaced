/**
 * The referral lapse (CM-referral-01, ENGINE RF-4; J-campaigns-05 #7).
 *
 * A referral relationship ends when the referred person has had no fee event for the owner's inactivity period
 * `IDENTITY_REFERRAL_LAPSE_PERIOD_SECONDS`, counted from the later of the attach and their latest fee event. The sweep
 * removes the edge and writes one `referral_lapses` row in one statement, under the referral graph lock; the row is
 * keyed by the edge, so a second sweep (or a second process) of the same edge writes nothing.
 * From then on nobody above the person earns from their fees. Stored accruals are not touched. The person may attach
 * again through a link: their attach window is measured from the lapse (see `attachWindowStart`).
 *
 * A blank period refuses with `referral.lapse_period_unset` and the sweep does not run; a blank sweep interval
 * (`IDENTITY_REFERRAL_LAPSE_SWEEP_SECONDS`) leaves the timer off. Either way the service logs a status line saying so.
 *
 * Activity is what identity can see: every fee event a producer sends to the accrue door stamps `referral_activity` with
 * the database's clock, whether or not it earns commission (rates unset, a frozen referrer, a zero rate). A trade whose
 * fee was never sent to identity does not count, so a producer that does not report its fees lets a relationship lapse.
 * A fee event that arrives while the sweep is ending that same relationship may still accrue to the old referrer: the fee
 * was paid inside the relationship, and the accrue door does not take the graph lock.
 */

import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { REFERRAL_GRAPH_LOCK_CLASS, REFERRAL_GRAPH_LOCK_OBJ } from './referral-service.js';
import { ReferralError } from './referral-tree.js';

/** Upper bound a published period may take (ten years). A larger value is a typo, not a setting. */
export const LAPSE_PERIOD_MAX_SECONDS = 315_360_000;
/** Upper bound for the sweep cadence (one day). */
export const LAPSE_SWEEP_MAX_SECONDS = 86_400;

function parseSeconds(name: string, raw: string | undefined, max: number): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > max) {
    throw new Error(`${name} must be whole seconds from 1 to ${max}`);
  }
  return Number(value);
}

/** The owner's inactivity period, parsed. Blank stays undefined (the sweep refuses); malformed stops the service. */
export const parseLapsePeriodSeconds = (raw: string | undefined) =>
  parseSeconds('IDENTITY_REFERRAL_LAPSE_PERIOD_SECONDS', raw, LAPSE_PERIOD_MAX_SECONDS);

/** How often the sweep runs, parsed. Blank stays undefined (no timer); malformed stops the service. */
export const parseLapseSweepSeconds = (raw: string | undefined) =>
  parseSeconds('IDENTITY_REFERRAL_LAPSE_SWEEP_SECONDS', raw, LAPSE_SWEEP_MAX_SECONDS);

/**
 * When this person's attach window starts: sign-up, or the end of their latest lapsed relationship, whichever is later.
 * Read inside the caller's transaction so the window and the write see the same rows.
 */
export async function attachWindowStart(
  sql: Sql,
  userId: string,
): Promise<{ start: Date; createdAt: Date; reopenedAt: Date | null; now: Date } | null> {
  const rows = await sql<Array<{ created_at: Date; reopened_at: Date | null; now: Date }>>`
    SELECT u.created_at,
           (SELECT max(l.lapsed_at) FROM referral_lapses l WHERE l.user_id = u.id) AS reopened_at,
           now() AS now
    FROM users u WHERE u.id = ${userId}
  `;
  const row = rows[0];
  if (!row) return null;
  const reopenedAt = row.reopened_at && row.reopened_at > row.created_at ? row.reopened_at : null;
  return { start: reopenedAt ?? row.created_at, createdAt: row.created_at, reopenedAt, now: row.now };
}

export type ReferralLapse = {
  readonly userId: string;
  readonly referrerId: string;
  readonly attributedAt: Date;
  readonly lastActivityAt: Date;
  readonly periodSeconds: number;
  readonly lapsedAt: Date;
};

type LapseRow = {
  user_id: string;
  referrer_id: string;
  attributed_at: Date;
  last_activity_at: Date;
  period_seconds: number;
  lapsed_at: Date;
};

const toLapse = (r: LapseRow): ReferralLapse => ({
  userId: r.user_id,
  referrerId: r.referrer_id,
  attributedAt: r.attributed_at,
  lastActivityAt: r.last_activity_at,
  periodSeconds: r.period_seconds,
  lapsedAt: r.lapsed_at,
});

/** Where this person's current relationship stands against the period: none, a blank period (no end date invented), or active. */
export type LapseStanding =
  | { readonly state: 'unset' }
  | { readonly state: 'none' }
  | { readonly state: 'active'; readonly periodSeconds: number; readonly lastActivityAt: Date; readonly endsAt: Date };

export class ReferralLapseService {
  constructor(
    private readonly sql: Sql,
    private readonly options: { readonly periodSeconds: number | undefined },
  ) {}

  private period(): number {
    const period = this.options.periodSeconds;
    if (period === undefined) {
      throw new ReferralError(
        'The referral inactivity period is not set by the owner [referral.lapse_period_unset]',
        'referral.lapse_period_unset',
      );
    }
    return period;
  }

  /**
   * A fee event for this person reached identity: their activity is now, on the database's clock, never a time the
   * caller supplies. Unknown accounts are ignored.
   */
  async recordFeeEvent(userId: string): Promise<void> {
    await this.sql`
      INSERT INTO referral_activity (user_id, last_fee_at)
      SELECT id, now() FROM users WHERE id = ${userId}
      ON CONFLICT (user_id) DO UPDATE SET last_fee_at = GREATEST(referral_activity.last_fee_at, EXCLUDED.last_fee_at)
    `;
  }

  /** Ends every relationship past the period, once each. Returns the relationships this run ended. */
  async sweep(): Promise<ReferralLapse[]> {
    const period = this.period();
    return transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${REFERRAL_GRAPH_LOCK_CLASS}, ${REFERRAL_GRAPH_LOCK_OBJ})`;
        // Each edge's last activity: the later of its attach and the person's latest fee event. Due once that plus the
        // period is not after the database's now. One statement, so the edge's timestamps never leave the database
        // (a JS Date would cut them to milliseconds and miss the row).
        const written = await tx<LapseRow[]>`
          WITH due AS (
            SELECT user_id, referrer_id, attributed_at, last_activity_at FROM (
              SELECT e.user_id, e.referrer_id, e.attributed_at,
                     GREATEST(e.attributed_at, COALESCE(act.last_fee_at, e.attributed_at)) AS last_activity_at
              FROM referral_edges e LEFT JOIN referral_activity act ON act.user_id = e.user_id
            ) d
            WHERE d.last_activity_at + make_interval(secs => ${period}) <= now()
          ),
          ended AS (
            DELETE FROM referral_edges e USING due
            WHERE e.user_id = due.user_id AND e.referrer_id = due.referrer_id AND e.attributed_at = due.attributed_at
            RETURNING e.user_id
          )
          INSERT INTO referral_lapses (user_id, referrer_id, attributed_at, last_activity_at, period_seconds)
          SELECT due.user_id, due.referrer_id, due.attributed_at, due.last_activity_at, ${period}
          FROM due JOIN ended ON ended.user_id = due.user_id
          ON CONFLICT ON CONSTRAINT referral_lapses_edge_uq DO NOTHING
          RETURNING user_id, referrer_id, attributed_at, last_activity_at, period_seconds, lapsed_at
        `;
        const lapsed = written.map(toLapse);
        return lapsed;
      },
      { isolation: 'read committed', maxAttempts: 10 },
    );
  }

  /** This person's current relationship against the period, read without changing anything. */
  async standingOf(userId: string): Promise<LapseStanding> {
    const period = this.options.periodSeconds;
    const rows = await this.sql<Array<{ last_activity_at: Date }>>`
      SELECT GREATEST(e.attributed_at, COALESCE(act.last_fee_at, e.attributed_at)) AS last_activity_at
      FROM referral_edges e LEFT JOIN referral_activity act ON act.user_id = e.user_id WHERE e.user_id = ${userId}
    `;
    const row = rows[0];
    if (!row) return { state: 'none' };
    if (period === undefined) return { state: 'unset' };
    return {
      state: 'active',
      periodSeconds: period,
      lastActivityAt: row.last_activity_at,
      endsAt: new Date(row.last_activity_at.getTime() + period * 1000),
    };
  }

  /** This person's latest ended relationship, or null. */
  async latestOf(userId: string): Promise<ReferralLapse | null> {
    const rows = await this.sql<LapseRow[]>`
      SELECT user_id, referrer_id, attributed_at, last_activity_at, period_seconds, lapsed_at
      FROM referral_lapses WHERE user_id = ${userId} ORDER BY lapsed_at DESC LIMIT 1
    `;
    return rows[0] ? toLapse(rows[0]) : null;
  }

  /** The lapse log for founder-ops, newest first. */
  async log(limit: number): Promise<ReferralLapse[]> {
    const rows = await this.sql<LapseRow[]>`
      SELECT user_id, referrer_id, attributed_at, last_activity_at, period_seconds, lapsed_at
      FROM referral_lapses ORDER BY lapsed_at DESC LIMIT ${limit}
    `;
    return rows.map(toLapse);
  }
}

/** The line the service logs at start, so a blank setting is visible rather than silent. */
export function lapseSweepStatusLine(periodSeconds: number | undefined, sweepSeconds: number | undefined): string {
  if (periodSeconds === undefined)
    return 'referral lapse sweep off: IDENTITY_REFERRAL_LAPSE_PERIOD_SECONDS is unset [referral.lapse_period_unset]';
  if (sweepSeconds === undefined) return 'referral lapse sweep off: IDENTITY_REFERRAL_LAPSE_SWEEP_SECONDS is unset';
  return `referral lapse sweep on: period ${periodSeconds}s, every ${sweepSeconds}s`;
}
