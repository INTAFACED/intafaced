/**
 * Our builder fee on our users' venue fills (D-venue-07; J-derivatives-17): the poster posts `builderFeeEarn` once per
 * fill, scheduled with the futures jobs, and the founder console's recon reads the venue against the ledger. index.ts
 * calls `wireBuilderFees` once and `scheduleJobs` on the futures job host, so a journey that changes the builder fee
 * edits this file, not the service's wiring file.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Sql } from 'postgres';
import type { LedgerClient } from '@intafaced/ledger-client';
import { env } from '../env.js';
import type { JobHost } from '../futures/job-host.js';
import { SqlPreparedActionStore } from '../venue/prepared-action-store.js';
import { parseBuilderFee, type UserVenueDoor } from '../venue/user-venue-door.js';
import type { UserVenue } from '@intafaced/venue-contracts';
import { collectBuilderFees, type BuilderFeeClaimReader } from './builder-fee-collect.js';
import { SqlOwnFundsSweepStore } from './own-funds-sweep-store.js';
import { sweepOwnFunds, type OwnFundsSweepDeps } from './own-funds-sweep.js';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { postBuilderFees, type BuilderFeePosterDeps } from './builder-fee-poster.js';
import { builderFeeRecon, type BuilderFeeReconDeps } from './builder-fee-recon.js';
import { SqlBuilderFeeStore } from './builder-fee-store.js';

export function wireBuilderFees(deps: {
  sql: Sql;
  ledger: BuilderFeePosterDeps['ledger'] & BuilderFeeReconDeps['ledger'] & Pick<LedgerClient, 'post' | 'balance'>;
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
    // Collect (launch money model, rule 5; J-derivatives-17): every claim each venue itself records for our builder address
    // posts `builderFeeReceive` once, keyed by the venue's own claim id. A venue whose adapter reads no claim record
    // collects nothing and says why; one venue that can't be read leaves the others collected.
    const builder = parseBuilderFee(env.TRADE_USER_VENUE_BUILDER_ADDRESS, env.TRADE_USER_VENUE_BUILDER_FEE_BPS)?.address ?? '';
    if (userVenueDoors.length > 0 && env.TRADE_BUILDER_FEE_COLLECT === 'on') {
      host.every('venue.builder_fee_collect', env.TRADE_BUILDER_FEE_COLLECT_INTERVAL_MS, async () => {
        const stopped: unknown[] = [];
        for (const door of userVenueDoors) {
          try {
            const run = await collectBuilderFees({ reader: claimReader(await door.venue()), builder, ledger });
            if (run.status === 'waiting') {
              log.warn({ job: 'venue.builder_fee_collect', reason: run.reason }, 'builder fees: nothing collected');
            } else if (run.refused.length > 0) {
              log.error({ job: 'venue.builder_fee_collect', ...run }, 'builder fee claims the ledger refused stay uncollected');
            }
          } catch (error) {
            stopped.push(error);
          }
        }
        if (stopped.length > 0) throw stopped[0];
      });
    }
    // Move own funds (OWNER 288 Q4): on the owner's schedule, what each venue's builder account holds above the float goes to
    // our wallet, and the move posts once from the venue's own withdrawal record. Any owner value blank: it waits, naming it.
    const sweep = ownFundsSweepSettings(env);
    if (userVenueDoors.length > 0 && sweep.intervalMs !== null) {
      const store = new SqlOwnFundsSweepStore(sql);
      host.every('venue.own_funds_sweep', sweep.intervalMs, async () => {
        const stopped: unknown[] = [];
        for (const door of userVenueDoors) {
          try {
            const run = await sweepOwnFunds({
              venue: await door.venue(),
              builder,
              signer: sweep.signer,
              float: sweep.float,
              wallet: sweep.wallet,
              store,
              ledger,
            });
            if (run.status === 'waiting' || run.status === 'held' || run.status === 'refused') {
              log.error(
                { alert: 'trade.own_funds_sweep_waiting', job: 'venue.own_funds_sweep', ...run },
                'own funds: the sweep waits for a person',
              );
            }
          } catch (error) {
            stopped.push(error);
          }
        }
        if (stopped.length > 0) throw stopped[0];
      });
    } else if (userVenueDoors.length > 0) {
      log.warn({ job: 'venue.own_funds_sweep', reason: 'trade.own_funds_schedule_unset' }, 'own funds: no schedule, nothing is swept');
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

/** The owner's sweep settings, read once; a blank or malformed one is `null` (the sweep then waits, naming it). */
export function ownFundsSweepSettings(e: {
  TRADE_OWN_FUNDS_FLOAT: string;
  TRADE_OWN_FUNDS_SWEEP_INTERVAL_MS: string;
  TRADE_OWN_FUNDS_WALLET: string;
  TRADE_BUILDER_KEY_SEED: string;
}): { float: Amount | null; intervalMs: number | null; wallet: OwnFundsSweepDeps['wallet']; signer: OwnFundsSweepDeps['signer'] } {
  const floatText = e.TRADE_OWN_FUNDS_FLOAT.trim();
  const float = /^\d+(\.\d+)?$/.test(floatText) ? parseAmount(floatText) : null;
  const ms = Number(e.TRADE_OWN_FUNDS_SWEEP_INTERVAL_MS.trim());
  const intervalMs = e.TRADE_OWN_FUNDS_SWEEP_INTERVAL_MS.trim() !== '' && Number.isSafeInteger(ms) && ms >= 1_000 ? ms : null;
  const m = /^([a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*)=(0x[0-9a-fA-F]{40})$/.exec(e.TRADE_OWN_FUNDS_WALLET.trim());
  const wallet = m ? { walletId: m[1]!, address: m[2]!.toLowerCase() } : null;
  const seed = e.TRADE_BUILDER_KEY_SEED.trim();
  let signer: OwnFundsSweepDeps['signer'] = null;
  if (seed !== '') {
    const account = builderKeyFor(seed);
    signer = {
      address: account.address.toLowerCase(),
      sign: (typedData) => account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]),
    };
  }
  return { float, intervalMs, wallet, signer };
}

/** Our builder key, derived from the owner's seed and never stored (as `agent-key.ts` derives agent keys). */
export function builderKeyFor(seed: string) {
  return privateKeyToAccount(keccak256(toHex(`intafaced builder key\u0000${seed}`)));
}

/** The venue's claim record as the collect job reads it, or `null` when its adapter does not read one. */
export function claimReader(venue: UserVenue): BuilderFeeClaimReader | null {
  const read = venue.builderClaims?.bind(venue);
  if (!read) return null;
  return {
    venueId: venue.venue.id,
    claims: async (builder) =>
      (await read(builder)).value.map((c) => ({
        claimId: c.claimId,
        builder: c.builder,
        assetId: c.asset,
        amount: c.amount,
        claimedAt: c.claimedAt,
      })),
  };
}
