/**
 * Tells the person when a recurring buy is suspended for insufficient funds (J-copy-bots-otc-16 #6): svc-trade publishes
 * `trade.recurring_buy.paused` after the status moved, keyed by (ruleId, slot) so a resend is one event, and svc-notify
 * turns it into one in-app notice. A bus that fails is logged and never undoes the suspension: the rule's status stays the
 * record, and the room reads it.
 */
import type { EventBus } from '@intafaced/events';
import { formatAmount } from '@intafaced/ledger-client/money';
import type { RecurringNotices } from './recurring-buys.js';

export function busRecurringNotices(bus: Pick<EventBus, 'publish'>): RecurringNotices {
  return {
    async suspended(input) {
      try {
        await bus.publish(
          'recurringBuySuspended',
          {
            ruleId: input.ruleId,
            userId: input.userId,
            slot: input.slot,
            asset: input.asset,
            amount: formatAmount(input.amount),
            free: formatAmount(input.free),
            suspendedAt: input.at.toISOString(),
          },
          { idempotencyKey: `trade.recurring_buy.paused:${input.ruleId}:${input.slot}` },
        );
      } catch (err) {
        console.warn(JSON.stringify({ level: 'warn', msg: 'trade.recurring.notice_unsent', ruleId: input.ruleId, error: String(err) }));
      }
    },
  };
}
