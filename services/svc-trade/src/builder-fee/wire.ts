/**
 * Our builder fee on our users' venue fills (D-venue-07; J-derivatives-17): the poster posts `builderFeeEarn` once per
 * fill, scheduled with the futures jobs, and the founder console's recon reads the venue against the ledger. index.ts
 * calls `wireBuilderFees` once and `scheduleJobs` on the futures job host, so a journey that changes the builder fee
 * edits this file, not the service's wiring file.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from 'postgres';
import { env } from '../env.js';
import type { JobHost } from '../futures/job-host.js';
import { SqlPreparedActionStore } from '../venue/prepared-action-store.js';
import { parseBuilderFee, type UserVenueDoor } from '../venue/user-venue-door.js';
import { postBuilderFees, type BuilderFeePosterDeps } from './builder-fee-poster.js';
import { builderFeeRecon, type BuilderFeeReconDeps } from './builder-fee-recon.js';
import { SqlBuilderFeeStore } from './builder-fee-store.js';

export function wireBuilderFees(deps: {
  sql: Sql;
  ledger: BuilderFeePosterDeps['ledger'] & BuilderFeeReconDeps['ledger'];
  userVenue: UserVenueDoor | null;
  userVenueDoors: readonly UserVenueDoor[];
  log: Pick<FastifyBaseLogger, 'error' | 'warn'>;
}) {
  const { sql, ledger, userVenue, userVenueDoors, log } = deps;
  const builderFeeStore = new SqlBuilderFeeStore(sql);
  const venueActions = new SqlPreparedActionStore(sql);
  const builderFees = {
    recon: (from: Date, to: Date) =>
      builderFeeRecon(
        {
          venue: userVenue ? () => userVenue.venue() : null,
          ledger,
          store: builderFeeStore,
          routedOrders: (venueId, ids) => venueActions.builderFeeOrders(venueId, ids),
          // OWNER 288 change 1e: the venue's own totals are read for our builder address; blank leaves them unknown.
          builder: parseBuilderFee(env.TRADE_USER_VENUE_BUILDER_ADDRESS, env.TRADE_USER_VENUE_BUILDER_FEE_BPS)?.address ?? null,
          now: () => new Date(),
        },
        from,
        to,
      ),
  };

  /** The poster and the recon on the futures job host; index.ts calls it where they have always been scheduled. */
  function scheduleJobs(host: JobHost): void {
    // Our builder fee on our users' venue fills, posted once per fill while the door is on (D-venue-07), on every venue an
    // order can be routed to (J-derivatives-28): each venue's accounts, fills and keys are its own, so one venue that can't
    // be read or stops its run leaves the others' fills posted, and the job still fails for the next tick to retry it.
    if (userVenueDoors.length > 0 && env.TRADE_BUILDER_FEE_POSTER === 'on') {
      host.every('venue.builder_fees', env.TRADE_BUILDER_FEE_POSTER_INTERVAL_MS, async () => {
        const stopped: unknown[] = [];
        for (const door of userVenueDoors) {
          try {
            const run = await postBuilderFees({
              venue: () => door.venue(),
              ledger,
              store: builderFeeStore,
              ourOrders: (venueId, account, ids) => venueActions.sentBuilderFeeOrders(venueId, account, ids),
              // OWNER 288 change 1c: a stopped run is an alert naming the venue, the account and the fill; the run stays
              // stopped (the job host logs the throw) and the operations desk shows the time since the last complete run.
              onStop: (stop) =>
                log.error({ alert: 'trade.builder_fee_poster_stopped', job: 'venue.builder_fees', ...stop }, 'builder-fee poster stopped'),
              now: () => new Date(),
            });
            if (run.refused > 0 || run.unread.length > 0) {
              log.error(
                { job: 'venue.builder_fees', ...run },
                'builder fees the ledger refused, or accounts the venue would not read, stay unposted',
              );
            }
            if (run.notOurOrder > 0) {
              log.warn(
                { job: 'venue.builder_fees', venueId: run.venueId, notOurOrder: run.notOurOrder },
                'builder fees on orders not ours, not posted',
              );
            }
          } catch (error) {
            stopped.push(error);
          }
        }
        if (stopped.length > 0) throw stopped[0];
      });
    }
    // OWNER 288 change 1e: the builder-fee recon also runs on its own, over the last day, so a break is raised without anyone
    // opening the console. Read only: it posts nothing. A break or a venue whose totals are unknown is logged for the desk.
    if (userVenue) {
      host.every('venue.builder_fee_recon', env.TRADE_BUILDER_FEE_RECON_INTERVAL_MS, async () => {
        const to = new Date();
        const read = await builderFees.recon(new Date(to.getTime() - 86_400_000), to);
        for (const v of read.venues) {
          if (v.state === 'unknown') {
            log.warn({ job: 'venue.builder_fee_recon', code: v.code }, 'builder-fee recon: the venue could not be read');
          } else if (v.verdict === 'break') {
            const breaks = v.lines.filter((l) => l.status !== 'matched' && l.status !== 'not_our_order').length;
            const totals = v.venueTotals.state === 'known' ? v.venueTotals.rows.filter((r) => !r.earnedMatched || !r.owedMatched) : [];
            log.error(
              { alert: 'trade.builder_fee_recon_break', job: 'venue.builder_fee_recon', venueId: v.venueId, breaks, totals },
              'builder-fee recon: the venue and the ledger do not agree',
            );
          } else if (v.verdict === 'totals_unknown') {
            log.warn(
              { job: 'venue.builder_fee_recon', venueId: v.venueId, totals: v.venueTotals },
              "builder-fee recon: the venue's own totals are not known",
            );
          }
        }
      });
    }
  }

  return { builderFees, scheduleJobs };
}
