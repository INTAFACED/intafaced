/**
 * The skip log (CB-copy-11): one row per leader fill a follow did not copy, with the reason as a stable id.
 *
 * A row is a `skipped` step on the append-only mirror trail, so the trail's unique step index keeps it to one row per
 * follow and leader fill: a second attempt at the same fill (a re-run sweep, a redelivery) writes nothing. The row is
 * written before anything else is told about the skip, so a crash after it loses no reason. The reason is an id, never
 * the service's sentence and never a raw refusal code; the screen turns it into words.
 */
import { InsufficientFundsError } from '@intafaced/ledger-client';
import { TradingControlError } from '../controls/trading-controls.js';
import { TradeError } from '../spot/types.js';
import { CopyCloseError } from './copy-close-errors.js';
import { CopyError } from './errors.js';
import type { MirrorEventLog } from './mirror-events.js';

export const COPY_SKIP_REASONS = [
  /** The follower had paused the follow. */
  'paused',
  /** The follower had stopped the follow (or left, or withdrew the permission): no new opens. */
  'stopped',
  /** The leader was suspended or delisted by the operator. */
  'lead_stopped',
  /** A follower risk control held it back: loss or drawdown stop, open-copy limit, a limit that could not be read, or an account control. */
  'risk_control',
  /** The follower's balance did not cover the copy. */
  'insufficient_funds',
  /** The copy would have gone past the follower's per-order or total limit. */
  'max_copy_total',
  /** The copy's price was further from the leader's than the follower's slippage limit. */
  'copy_slippage_exceeded',
  /** A leader close found nothing copied left open to close. */
  'position_closed',
  /** Any other refusal. */
  'refused',
] as const;
export type CopySkipReason = (typeof COPY_SKIP_REASONS)[number];

const BY_COPY_CODE: Partial<Record<string, CopySkipReason>> = {
  'trade.copy_paused': 'paused',
  'trade.copy_stopped': 'stopped',
  'trade.copy_detached': 'stopped',
  'trade.copy_session_key_missing': 'stopped',
  'trade.copy_session_key_revoked': 'stopped',
  'trade.copy_key_expired': 'stopped',
  'trade.copy_leader_suspended': 'lead_stopped',
  'trade.copy_leader_delisted': 'lead_stopped',
  'trade.copy_drawdown_stop': 'risk_control',
  'trade.copy_concurrency_exceeded': 'risk_control',
  'trade.copy_limit_unevaluable': 'risk_control',
  'trade.copy_limit_missing': 'risk_control',
  'trade.copy_cap_exceeded': 'max_copy_total',
  'trade.copy_slippage_exceeded': 'copy_slippage_exceeded',
  'trade.copy_reserve_exceeds_balance': 'insufficient_funds',
  'trade.copy_position_closed': 'position_closed',
};

/** The reason id for a refusal that kept a leader fill from being copied. */
export function copySkipReasonFor(err: unknown): CopySkipReason {
  if (err instanceof InsufficientFundsError) return 'insufficient_funds';
  if (err instanceof TradingControlError) return 'risk_control';
  if (err instanceof CopyError || err instanceof CopyCloseError || err instanceof TradeError) {
    return BY_COPY_CODE[err.code] ?? 'refused';
  }
  return 'refused';
}

/** Whether a refusal is a typed one the copy driver treats as final for that fill (the fill is skipped, not retried). */
export function isCopySkipRefusal(err: unknown): boolean {
  return (
    err instanceof CopyError ||
    err instanceof CopyCloseError ||
    err instanceof TradingControlError ||
    err instanceof TradeError ||
    err instanceof InsufficientFundsError
  );
}

/** Writes the skip row. 'replay' means this fill already has one, and nothing was written. */
export function recordCopySkip(
  events: MirrorEventLog,
  input: { followId: string; leaderFillId: string; reason: CopySkipReason; at: Date },
): Promise<'inserted' | 'replay'> {
  return events.append({ followId: input.followId, leaderFillId: input.leaderFillId, kind: 'skipped', code: input.reason, at: input.at });
}

export type CopySkipRow = { readonly leaderFillId: string; readonly reason: CopySkipReason; readonly at: Date };

/** Newest first, at most this many: the screen's log reads one page. */
export const COPY_SKIP_LOG_LIMIT = 100;

export function asCopySkipReason(code: string | null): CopySkipReason {
  return (COPY_SKIP_REASONS as readonly string[]).includes(code ?? '') ? (code as CopySkipReason) : 'refused';
}
