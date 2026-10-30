/**
 * Tells the follower when a follow skipped a leader fill or stopped copying (J-copy-bots-otc-03 #6): svc-trade publishes
 * `trade.copy.skipped` and `trade.copy.stopped`, and svc-notify turns them into an in-app notice.
 *
 * Each is published after the row it reports is written, keyed so a resend is one event: a skip on
 * (followId, leaderFillId) and a stop on (followId, closeOnly). A bus that fails is logged and never undoes or holds up
 * the copy step itself; the skip log and the follow's state stay the record, and the screen reads them.
 *
 * A skip the follower caused (`paused`, `stopped`) is not published: they chose it, and a paused follow skips every
 * leader fill, so a notice each time would only be noise.
 */
import type { EventBus } from '@intafaced/events';
import type { CopySkipReason } from './skip-log.js';

/** Why a follow stopped copying, as `trade.copy.stopped` names it. */
export type CopyStopReason = 'follower' | 'lead_stopped' | 'risk_control' | 'permission_ended';

export interface CopyNotices {
  skipped(input: {
    followId: string;
    followerId: string;
    leaderId: string;
    leaderFillId: string;
    reason: CopySkipReason;
    at: Date;
  }): Promise<void>;
  stopped(input: {
    followId: string;
    followerId: string;
    leaderId: string;
    reason: CopyStopReason;
    closeOnly: boolean;
    at: Date;
  }): Promise<void>;
}

/** The skips the follower did not choose, so they are told. */
const SKIPS_TOLD: ReadonlySet<CopySkipReason> = new Set<CopySkipReason>([
  'lead_stopped',
  'risk_control',
  'insufficient_funds',
  'max_copy_total',
  'copy_slippage_exceeded',
  'position_closed',
  'refused',
]);

type Warn = (message: string, fields: Record<string, string>) => void;

const defaultWarn: Warn = (message, fields) => console.warn(JSON.stringify({ level: 'warn', msg: message, ...fields }));

export function busCopyNotices(bus: Pick<EventBus, 'publish'>, warn: Warn = defaultWarn): CopyNotices {
  return {
    async skipped(input) {
      if (!SKIPS_TOLD.has(input.reason)) return;
      try {
        await bus.publish(
          'copySkipped',
          {
            followId: input.followId,
            followerId: input.followerId,
            leaderId: input.leaderId,
            leaderFillId: input.leaderFillId,
            reason: input.reason,
            skippedAt: input.at.toISOString(),
          },
          { idempotencyKey: `trade.copy.skipped:${input.followId}:${input.leaderFillId}` },
        );
      } catch (err) {
        warn('trade.copy.notice_unsent', { event: 'copy.skipped', followId: input.followId, error: String(err) });
      }
    },
    async stopped(input) {
      try {
        await bus.publish(
          'copyStopped',
          {
            followId: input.followId,
            followerId: input.followerId,
            leaderId: input.leaderId,
            reason: input.reason,
            closeOnly: input.closeOnly,
            stoppedAt: input.at.toISOString(),
          },
          { idempotencyKey: `trade.copy.stopped:${input.followId}:${input.closeOnly}` },
        );
      } catch (err) {
        warn('trade.copy.notice_unsent', { event: 'copy.stopped', followId: input.followId, error: String(err) });
      }
    },
  };
}

/** No bus wired: nothing is told. */
export const NO_COPY_NOTICES: CopyNotices = { skipped: async () => {}, stopped: async () => {} };
