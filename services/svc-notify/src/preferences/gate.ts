/**
 * Decide whether one out-of-app channel sends, records a topic mute, or waits
 * for the next summary. Critical never reaches this function.
 */

import type { MuteableChannel, NotifySeverity } from './mute.js';
import { topicFromKind } from './combined.js';
import type { AccountPrefs, HoldStore } from './account.js';
import type { CategoryPrefs } from './categories.js';

export type OutOfAppPlan = 'send' | 'muted' | 'hold';

export function planOutOfApp(deps: { account: AccountPrefs; holds: HoldStore; now: () => Date; categories?: CategoryPrefs }) {
  return async (input: {
    userId: string;
    kind: string;
    notificationId: string;
    channel: MuteableChannel;
    severity: NotifySeverity;
  }): Promise<OutOfAppPlan> => {
    if (input.severity === 'critical') return 'send';
    if (await deps.holds.has(input.notificationId, input.channel)) return 'hold';
    const topic = topicFromKind(input.kind);
    if (topic) {
      const rows = await deps.account.topicPrefs(input.userId);
      const row = rows.find((item) => item.topic === topic && item.channel === input.channel);
      if (row && !row.enabled) return 'muted';
    }
    if (deps.categories && !(await deps.categories.allows(input.userId, input.kind, input.channel))) return 'muted';
    const until = await deps.account.holdUntil(input.userId, input.severity, deps.now());
    if (!until) return 'send';
    await deps.holds.hold({
      userId: input.userId,
      notificationId: input.notificationId,
      channel: input.channel,
      holdUntil: until,
    });
    return 'hold';
  };
}
