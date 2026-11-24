import type { Sql } from 'postgres';
import { z } from 'zod';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import type { AsOf, MaybeKnown, UserVenueAccount, UserVenueAccountSummary } from '@intafaced/venue-contracts';

/** At most this many readings are returned for one account, newest first. */
const MARGIN_HISTORY_MAX = 200;

/**
 * One reading of a venue account's margin, every figure the venue's own at its as-of time (J-derivatives-26 #8). With a
 * cross position open it is the venue's cross margin (equity, maintenance requirement, ratio and its margin-call state);
 * with none, the account's margin summary and `crossState` null.
 */
export interface VenueMarginSample {
  readonly asOf: Date;
  readonly asset: string;
  readonly equity: bigint;
  readonly maintenanceMargin: bigint;
  readonly marginRatio: MaybeKnown<bigint>;
  readonly crossState: 'healthy' | 'margin_call' | null;
}

/** The reading a margin summary read gives. */
export function sampleOf(read: AsOf<UserVenueAccountSummary>): VenueMarginSample {
  const s = read.value;
  const c = s.cross ?? null;
  return {
    asOf: read.asOf,
    asset: s.asset,
    equity: c ? c.equity : s.equity,
    maintenanceMargin: c ? c.maintenanceMargin : s.maintenanceMargin,
    marginRatio: c ? c.marginRatio : s.marginRatio,
    crossState: c ? c.state : null,
  };
}

/** Where the readings are kept: `VenueMarginSamples` on trade's database. */
export interface MarginSampleStore {
  record(account: UserVenueAccount, read: AsOf<UserVenueAccountSummary>): Promise<void>;
  history(account: UserVenueAccount): Promise<VenueMarginSample[]>;
}

const SampleRow = z.object({
  as_of: z.date(),
  asset: z.string(),
  equity: z.string(),
  maintenance_margin: z.string(),
  margin_ratio: z.string().nullable(),
  cross_state: z.enum(['healthy', 'margin_call']).nullable(),
});

/**
 * The venue account's margin readings, in `trade.venue_margin_samples`. The outside venue reports the margin now and keeps
 * no history of it, so each read through our door keeps what the venue said, at the venue's as-of time; a reading equal
 * to the account's latest kept one is not kept again. Nothing here is ours: a founder reads it as the venue's history.
 */
export class VenueMarginSamples implements MarginSampleStore {
  constructor(
    private readonly sql: Sql,
    /** Where a reading that could not be kept is reported; the person's own read never fails for it. */
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  /** Keeps the reading, never failing the read it came from: a reading that cannot be kept is reported to `onError`. */
  async keep(account: UserVenueAccount, read: AsOf<UserVenueAccountSummary>): Promise<void> {
    await this.record(account, read).catch(this.onError);
  }

  async record(account: UserVenueAccount, read: AsOf<UserVenueAccountSummary>): Promise<void> {
    const s = sampleOf(read);
    const sub = account.subAccount ?? '';
    const equity = formatAmount(s.equity);
    const maintenance = formatAmount(s.maintenanceMargin);
    const ratio = s.marginRatio.known ? formatAmount(s.marginRatio.value) : null;
    await this.sql`
      INSERT INTO trade.venue_margin_samples
        (venue_id, owner, sub_account, as_of, asset, equity, maintenance_margin, margin_ratio, cross_state)
      SELECT ${account.venueId}, ${account.owner.toLowerCase()}, ${sub}, ${s.asOf}, ${s.asset}, ${equity}, ${maintenance},
             ${ratio}, ${s.crossState}
       WHERE NOT EXISTS (
         SELECT 1 FROM (
           SELECT asset, equity, maintenance_margin, margin_ratio, cross_state
             FROM trade.venue_margin_samples
            WHERE venue_id = ${account.venueId} AND owner = ${account.owner.toLowerCase()} AND sub_account = ${sub}
            ORDER BY as_of DESC LIMIT 1
         ) latest
          WHERE latest.asset = ${s.asset} AND latest.equity = ${equity}::numeric
            AND latest.maintenance_margin = ${maintenance}::numeric
            AND latest.margin_ratio IS NOT DISTINCT FROM ${ratio}::numeric
            AND latest.cross_state IS NOT DISTINCT FROM ${s.crossState}
       )
      ON CONFLICT DO NOTHING
    `;
  }

  /** The account's kept readings, newest first, at most `MARGIN_HISTORY_MAX`. */
  async history(account: UserVenueAccount): Promise<VenueMarginSample[]> {
    const rows = SampleRow.array().parse(
      await this.sql`
      SELECT as_of, asset, equity::text AS equity, maintenance_margin::text AS maintenance_margin,
             margin_ratio::text AS margin_ratio, cross_state
        FROM trade.venue_margin_samples
       WHERE venue_id = ${account.venueId} AND owner = ${account.owner.toLowerCase()} AND sub_account = ${account.subAccount ?? ''}
       ORDER BY as_of DESC
       LIMIT ${MARGIN_HISTORY_MAX}
    `,
    );
    return rows.map((r) => ({
      asOf: r.as_of,
      asset: r.asset,
      equity: parseAmount(r.equity),
      maintenanceMargin: parseAmount(r.maintenance_margin),
      marginRatio: r.margin_ratio === null ? { known: false } : { known: true, value: parseAmount(r.margin_ratio) },
      crossState: r.cross_state,
    }));
  }
}
