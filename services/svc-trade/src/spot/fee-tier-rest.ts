/**
 * GET /api/v1/account/fee-tier: the caller's own fee tier and how it was reached (SP-fees-vip-03, J-cex-spot-10 #5-#6).
 *
 * The tier is the one an order placed now keeps (`feeTierAt`), with the VIP trial it comes from when it does. Beside it: the owner's programme as published (or none:
 * "Thresholds not set"), the volume counted toward the next snapshot and what it reaches, the next threshold, when the
 * next snapshot runs (none without a snapshot time), what is excluded, and the caller's own snapshot rows with the
 * figures each used. Self only: the user is the edge-signed principal, never a query field.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { AuthError, requireScope } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import type { EdgeTrust } from '../edge-trust.js';
import { REGULAR_FEE_TIER, type OwnerFeeSchedule } from './fee-schedule.js';
import {
  VOLUME_EXCLUSIONS,
  countedVolume,
  programmeSince,
  snapshotInForce,
  snapshotsOf,
  tierOf,
  trialGiving,
  trialsInForce,
} from './fee-tier-store.js';
import { nextSnapshotInstant, nextThreshold, tierForVolume, volumeWindow } from './fee-tiers.js';
import { privateRead } from '../route-inventory.js';

export const ACCOUNT_FEE_TIER_PATH = '/api/v1/account/fee-tier';

/** Snapshot rows a read returns, newest first. */
export const FEE_TIER_SNAPSHOT_ROWS = 10;

export interface FeeTierRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  sql: Sql;
  scheduleAt(at: Date): Promise<OwnerFeeSchedule>;
  /** The boot schedule (TRADE_FEE_SCHEDULE), in force before every stored version. */
  bootSchedule: OwnerFeeSchedule;
  /** False when the snapshot job is not scheduled here: no snapshot runs, whatever the programme says. */
  snapshotsRunning: boolean;
  now?: () => Date;
}

export function registerFeeTierRest(app: FastifyInstance, deps: FeeTierRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });
  const now = deps.now ?? (() => new Date());

  app.get(ACCOUNT_FEE_TIER_PATH, privateRead, async (req, reply) => {
    const edgeReq: EdgeRequest = { headers: req.headers as Record<string, string | string[] | undefined>, id: req.id };
    const principal = edgeContext(edgeReq).principal;
    if (!principal) return reply.code(401).send({ code: 'trade.unauthenticated', message: 'signed principal required' });
    try {
      requireScope(principal, 'trade:read');
    } catch (error) {
      if (error instanceof AuthError) return reply.code(403).send({ code: 'trade.permission_denied', message: error.message });
      throw error;
    }

    const at = now();
    const schedule = await deps.scheduleAt(at);
    if (schedule.published !== true) {
      return reply.code(503).send({ code: 'trade.fee_schedule_blank', message: 'published fee schedule is unavailable' });
    }
    const userId = principal.userId;
    const program = schedule.tierProgram ?? null;
    const [inForce, snapshots, trials] = await Promise.all([
      snapshotInForce(deps.sql, userId, at),
      snapshotsOf(deps.sql, userId, FEE_TIER_SNAPSHOT_ROWS),
      trialsInForce(deps.sql, userId, at),
    ]);
    const tier = tierOf(schedule, inForce, trials);
    // The VIP trial the tier comes from (vip-review.ts), or none. A snapshot that gives the same tier is named instead:
    // the tier does not end with the trial.
    const trial = inForce?.tierId === tier ? null : trialGiving(tier, trials);
    // The snapshot the tier comes from, or none: a snapshot whose tier the programme in force no longer names gives
    // regular, and is not shown as where the tier came from (it stays in the rows below).
    const source = inForce && inForce.tierId === tier ? inForce : null;
    if (!program) {
      return reply.code(200).send({
        tier: REGULAR_FEE_TIER,
        scheduleVersion: schedule.version,
        program: null,
        volume: null,
        next: null,
        snapshotsRunning: deps.snapshotsRunning,
        nextSnapshotAt: null,
        lastSnapshot: null,
        trial: null,
        snapshots,
        excluded: VOLUME_EXCLUSIONS,
      });
    }

    const since = await programmeSince(deps.sql, deps.bootSchedule, at);
    const nextAt = deps.snapshotsRunning ? nextSnapshotInstant(program, since, at) : null;
    // The volume the next snapshot counts so far: its window up to now, so a fill that drops out of the 30 days before
    // it is not counted toward it. With no snapshot due, the 30 days before now.
    const from = volumeWindow(nextAt ?? at).from;
    const counted = await countedVolume(deps.sql, program, userId, from, at);
    const volume = parseAmount(counted.volume);
    return reply.code(200).send({
      tier,
      scheduleVersion: schedule.version,
      program: {
        thresholds: program.thresholds,
        volumeQuotes: program.volumeQuotes,
        snapshotTimeUtc: program.snapshotTimeUtc,
        benefits: program.benefits,
        downgradeGraceDays: null,
        subAccounts: null,
        botsAndCopy: null,
        assets: null,
      },
      volume: {
        amount: counted.volume,
        fills: counted.fills,
        from: from.toISOString(),
        to: at.toISOString(),
        // What this volume reaches at the next snapshot; the tier above stays until then.
        reaches: tierForVolume(program, volume),
      },
      next: nextThreshold(program, volume),
      snapshotsRunning: deps.snapshotsRunning,
      nextSnapshotAt: nextAt?.toISOString() ?? null,
      lastSnapshot: source,
      trial,
      snapshots,
      excluded: VOLUME_EXCLUSIONS,
    });
  });
}
