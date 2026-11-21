import type { BankRoot } from '../bank-root.js';
import { ScheduledNoticeService, type ScheduledNoticeSink } from './scheduled-notices.js';

/** Payment reminders and standing-order notices. An area of svc-bank (`area-chain.ts`). */
export interface RulesServices {
  /** BK-acct-10: the payment reminder rule and the standing-order notice outbox. Posts nothing. */
  readonly scheduledNotices: ScheduledNoticeService;
}

export interface RulesServiceOptions {
  /** Standing-order reminders and failure notices. Unset = owed notices stay owed and the job names `bank.scheduled_notify_unwired`. */
  scheduledNotices?: ScheduledNoticeSink;
}

export function composeRulesArea(root: BankRoot, _made: object, options: RulesServiceOptions): RulesServices {
  return {
    scheduledNotices: new ScheduledNoticeService(root.sql, {
      sink: options.scheduledNotices,
      log: (event, detail) => console.error(JSON.stringify({ level: 'error', service: 'svc-bank', event, detail })),
    }),
  };
}
