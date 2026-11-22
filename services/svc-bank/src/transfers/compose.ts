import type { Sql } from 'postgres';
import type { BankRoot } from '../bank-root.js';
import { ReceivedHoldService } from '../holds/received-holds.js';
import type { RampServiceOptions } from '../ramps/ramp-service.js';
import type { IncomeSorterService } from '../sorter/income-sorter.js';
import type { BillsPotService } from '../spaces/bills-pot.js';
import type { SpaceService } from '../spaces/space-service.js';
import type { PartyHandlePort } from './party-handles.js';
import { PersonalPayService, type RemindPolicy } from './personal-pay.js';
import type { PersonalRequestNotices } from './request-notices.js';
import type { SendReviewRule } from './send-review.js';
import type { PersonalTransferNotices } from './transfer-notices.js';
import { TransferService } from './transfer-service.js';

/** Transfers, standing orders, personal pay and held payments from strangers. An area of svc-bank (`area-chain.ts`). */
export interface TransfersServices {
  readonly transfers: TransferService;
  readonly personalPay: PersonalPayService;
  /** PP-money-balance-05: payments from people not in the recipient's contacts, held for them to accept. */
  readonly receivedHolds: ReceivedHoldService;
  /**
   * Operator transfer reads. The same connection the services use.
   * The procedures only SELECT. They do not post.
   */
  readonly transferOps: {
    readonly sql: Sql;
    readonly handles?: PartyHandlePort;
  };
}

export interface TransfersServiceOptions {
  /** `BANK_SCHEDULE_EDIT_CUTOFF_MINUTES`: how close to its next run a standing order may still be edited. Blank refuses. */
  scheduleEditCutoffMinutes?: string;
  /** `BANK_STRANGER_HOLD_DAYS`, parsed: how long a held payment from a stranger waits. Null: no such hold can be placed. */
  strangerHoldDays?: number | null;
  /** `BANK_PERSONAL_SEND_REVIEW_JSON`, parsed: the owner's send review rule. Unset, no send is held. */
  sendReviewRule?: SendReviewRule | null;
  /** `BANK_REQUEST_REMIND_POLICY_JSON`, parsed: the owner's reminder cap per window. Null refuses every reminder. */
  remindPolicy?: RemindPolicy | null;
  /** Public handles for receipts. Unset = receipts name `bank.party_handles_unset` and requests refuse. */
  handles?: PartyHandlePort;
  /** Inbox events for payment requests. Unset = the request is stored and the notice names `bank.pay_request_notify_unwired`. */
  requestNotices?: PersonalRequestNotices;
  /** Inbox events for a posted personal send (both people). Unset = no notice; the send is unaffected. */
  transferNotices?: PersonalTransferNotices;
  /** The security lock (the ramps area's option): a locked person's personal send refuses. */
  ramps?: Pick<RampServiceOptions, 'securityLock'>;
}

export function composeTransfersArea(
  root: BankRoot,
  made: { readonly spaces: SpaceService; readonly billsPots: BillsPotService; readonly sorter: IncomeSorterService },
  options: TransfersServiceOptions,
): TransfersServices {
  const { sql, ledger } = root;
  const transfers = new TransferService(sql, ledger, made.spaces, { editCutoffMinutes: options.scheduleEditCutoffMinutes }, made.billsPots);
  const receivedHolds = new ReceivedHoldService(sql, ledger, { holdDays: options.strangerHoldDays ?? null });
  const personalPay = new PersonalPayService(sql, ledger, transfers, made.spaces, {
    receivedHolds,
    handles: options.handles,
    notices: options.requestNotices,
    transferNotices: options.transferNotices,
    onCreditPosted: (credit) => made.sorter.sortCredit(credit),
    securityLock: options.ramps?.securityLock,
    reviewRule: options.sendReviewRule ?? null,
    remindPolicy: options.remindPolicy ?? null,
    custody: root.custody,
  });
  return { transfers, personalPay, receivedHolds, transferOps: { sql, handles: options.handles } };
}
