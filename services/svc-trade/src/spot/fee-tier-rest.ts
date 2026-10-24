/**
 * GET /api/v1/account/fee-tier: the caller's own fee tier and how it was reached (SP-fees-vip-03, J-cex-spot-10 #5-#6).
 *
 * The tier is the one an order placed now keeps (`feeTierAt`). Beside it: the owner's programme as published (or none:
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
import { VOLUME_EXCLUSIONS, countedVolume, feeTierAt, snapshotInForce, snapshotsOf, versionInForce } from './fee-tier-store.js';
import { TIER_VOLUME_DAYS, nextSnapshotInstant, nextThreshold, tierForVolume } from './fee-tiers.js';

export const ACCOUNT_FEE_TIER_PATH = '/api/v1/account/fee-tier';

/** Snapshot rows a read returns, newest first. */
export const FEE_TIER_SNAPSHOT_ROWS = 10;

export interface FeeTierRestDeps {
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  sql: Sql;
  scheduleAt(at: Date): Promise<OwnerFeeSchedule>;
  /** When the boot schedule took effect (this process's start), for a programme on the boot value. */
  bootedAt: Date;
  /** False when the snapshot job is not scheduled here: no snapshot runs, whatever the programme says. */
  snapshotsRunning: boolean;
  now?: () => Date;
}

export function registerFeeTierRest(app: FastifyInstance, deps: FeeTierRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });
  const now = deps.now ?? (() => new Date());

  app.get(ACCOUNT_FEE_TIER_PATH, async (req, reply) => {
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
    const [tier, inForce, snapshots] = await Promise.all([
      feeTierAt(deps.sql, schedule, userId, at),
      snapshotInForce(deps.sql, userId, at),
      snapshotsOf(deps.sql, userId, FEE_TIER_SNAPSHOT_ROWS),
    ]);
    if (!program) {
      return reply.code(200).send({
        tier: REGULAR_FEE_TIER,
        scheduleVersion: schedule.version,
        program: null,
        volume: null,
        next: null,
        snapshotsRunning: deps.snapshotsRunning,
        nextSnapshotAt: null,
        lastSnapshot: inForce,
        snapshots,
        excluded: VOLUME_EXCLUSIONS,
      });
    }

    const from = new Date(at.getTime() - TIER_VOLUME_DAYS * 86_400_000);
    const counted = await countedVolume(deps.sql, program, userId, from, at);
    const volume = parseAmount(counted.volume);
    const since = (await versionInForce(deps.sql, at))?.effectiveAt ?? deps.bootedAt;
    const nextAt = deps.snapshotsRunning ? nextSnapshotInstant(program, since, at) : null;
    return reply.code(200).send({
      tier,
      scheduleVersion: schedule.version,
      program: {
        thresholds: program.thresholds,
        volumeQuotes: program.volumeQuotes,
        snapshotTimeUtc: program.snapshotTimeUtc,
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
      lastSnapshot: inForce,
      snapshots,
      excluded: VOLUME_EXCLUSIONS,
    });
  });
}
