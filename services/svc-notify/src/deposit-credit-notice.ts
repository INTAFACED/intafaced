import type { NotifyService } from './notify-service.js';

/**
 * Deposit credit inbox row. Distinct from `trade.fill`.
 *
 * The live writer of this row is the `payDepositCreditPosted` consumer in
 * events.ts (svc-pay announces each credit after its ledger post), keyed on the
 * deposit id. `notifyDepositCredit` below is the earlier seam, kept for its
 * acceptance test and wired nowhere: wiring it as well would write a second row
 * for the same deposit under another key. It writes only when the watcher is up,
 * confirmations meet the published minimum, and available balance is already
 * credited, and never books the credit: svc-notify holds no balances.
 */

export const DEPOSIT_CREDITED_KIND = 'bank.deposit.credited';
export const TRADE_FILL_KIND = 'trade.fill';
export const DEPOSIT_CREDITED_SUBJECT = 'intafaced.notify.bank.deposit.credited';
export const DEPOSIT_CREDITED_TITLE_KEY = 'notify.bank.deposit.credited.title';
export const DEPOSIT_CREDITED_BODY_KEY = 'notify.bank.deposit.credited.body';

const POSITIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

export interface DepositObservation {
  readonly railEventId: string;
  readonly userId: string;
  readonly confirmations: number;
  readonly minConfirmations: number;
  readonly availableCredited: boolean;
  readonly amount: string;
  readonly asset: string;
}

export type ChainWatcherReport = { readonly status: 'down' } | { readonly status: 'up'; readonly observation: DepositObservation };

export interface DepositCreditBook {
  credit(observation: DepositObservation): void;
}

export type DepositNoticeOutcome = 'watcher_down' | 'unconfirmed' | 'not_credited' | 'stored' | 'duplicate';

export interface DepositNoticeResult {
  readonly outcome: DepositNoticeOutcome;
  readonly kind: typeof DEPOSIT_CREDITED_KIND | null;
}

export interface DepositCreditNoticeInput {
  readonly watch: () => Promise<ChainWatcherReport> | ChainWatcherReport;
  readonly book: DepositCreditBook;
}

function positiveDecimal(amount: string): boolean {
  if (!POSITIVE_DECIMAL.test(amount)) return false;
  return !/^0(?:\.0+)?$/.test(amount);
}

function confirmed(observation: DepositObservation): boolean {
  return (
    Number.isInteger(observation.confirmations) &&
    Number.isInteger(observation.minConfirmations) &&
    observation.minConfirmations >= 0 &&
    observation.confirmations >= observation.minConfirmations
  );
}

export async function notifyDepositCredit(notify: NotifyService, input: DepositCreditNoticeInput): Promise<DepositNoticeResult> {
  if (typeof input.book.credit !== 'function') {
    return { outcome: 'watcher_down', kind: null };
  }

  let report: ChainWatcherReport;
  try {
    report = await input.watch();
  } catch {
    return { outcome: 'watcher_down', kind: null };
  }
  if (report.status !== 'up') {
    return { outcome: 'watcher_down', kind: null };
  }

  const observation = report.observation;
  if (!confirmed(observation)) {
    return { outcome: 'unconfirmed', kind: null };
  }
  if (!observation.availableCredited) {
    return { outcome: 'not_credited', kind: null };
  }
  if (
    observation.railEventId.trim() === '' ||
    observation.userId.trim() === '' ||
    observation.asset.trim() === '' ||
    !positiveDecimal(observation.amount)
  ) {
    return { outcome: 'not_credited', kind: null };
  }

  const created = await notify.create({
    userId: observation.userId,
    kind: DEPOSIT_CREDITED_KIND,
    titleKey: DEPOSIT_CREDITED_TITLE_KEY,
    bodyKey: DEPOSIT_CREDITED_BODY_KEY,
    params: {
      amount: observation.amount,
      asset: observation.asset,
      railEventId: observation.railEventId,
      confirmations: observation.confirmations,
      minConfirmations: observation.minConfirmations,
    },
    href: null,
    severity: 'info',
    sourceSubject: DEPOSIT_CREDITED_SUBJECT,
    sourceIdempotencyKey: observation.railEventId,
    outOfApp: false,
  });

  return {
    outcome: created.inserted ? 'stored' : 'duplicate',
    kind: DEPOSIT_CREDITED_KIND,
  };
}
