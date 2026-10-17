/**
 * When a hold is due, send it on the held channel and only then write the summary.
 * A retryable send leaves the hold open for the next tick.
 */

import type { DigestSummary, DueHold, HoldStore } from './account.js';
import type { MuteableChannel } from './mute.js';

export interface HeldReleaseOutcome {
  readonly status: string;
  readonly retryable: boolean;
}

export interface HeldReleaser {
  releaseHeld(userId: string, notificationId: string, channel: MuteableChannel): Promise<HeldReleaseOutcome>;
}

function isTerminalRelease(outcome: HeldReleaseOutcome): boolean {
  if (outcome.retryable) return false;
  return (
    outcome.status === 'accepted' ||
    outcome.status === 'already_accepted' ||
    outcome.status === 'refused' ||
    outcome.status === 'abandoned' ||
    outcome.status === 'failed'
  );
}

/**
 * One summary per user. Each notice id is listed once.
 * Holds that throw or still need a retry stay due and are absent from the summary.
 */
export async function releaseDueHolds(holds: HoldStore, dispatcher: HeldReleaser, now: Date): Promise<readonly DigestSummary[]> {
  const due = await holds.listDue(now);
  const byUser = new Map<string, DueHold[]>();
  for (const row of due) {
    const list = byUser.get(row.userId);
    if (list) list.push(row);
    else byUser.set(row.userId, [row]);
  }

  const summaries: DigestSummary[] = [];
  for (const [userId, rows] of byUser) {
    const released: string[] = [];
    for (const row of rows) {
      let outcome: HeldReleaseOutcome;
      try {
        outcome = await dispatcher.releaseHeld(row.userId, row.notificationId, row.channel);
      } catch {
        continue;
      }
      if (!isTerminalRelease(outcome)) continue;
      released.push(row.id);
    }
    if (released.length === 0) continue;
    const summary = await holds.markReleased(userId, now, released);
    if (summary) summaries.push(summary);
  }
  return summaries;
}
