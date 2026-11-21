import type { BankRoot } from '../bank-root.js';
import type { SpaceService } from '../spaces/space-service.js';
import { BillPayService } from './bills.js';
import { GlobalSendService } from './global.js';
import { BANK_GLOBAL_HOLD_CANCEL_HOURS_ENV, GlobalHoldService } from './holds.js';
import { emptyBillPorts, emptyGlobalPorts, type BillPorts, type GlobalPorts } from './ports.js';

/** Bill pay and global sends with their holds. An area of svc-bank (`area-chain.ts`). */
export interface PersonalPayAreaServices {
  readonly bills: BillPayService;
  readonly globalSend: GlobalSendService;
  readonly globalHolds: GlobalHoldService;
}

export interface PersonalPayAreaOptions {
  /**
   * Bill-pay ports. Unset refuses search, lookup, pay and recurring create.
   * Nothing here invents a biller, an amount due or a PSP.
   */
  bills?: BillPorts;
  /**
   * Global-send ports. Unset refuses corridors, quotes and sends.
   * Travel-rule `decision()` null means Nitro/Phantom have not decided.
   */
  global?: GlobalPorts;
  /** Owner-published purpose, source-of-funds and reference rules for a global send (JSON). Blank refuses. */
  sendFieldRules?: string | undefined;
  /** Owner-published payee controls (JSON). Blank refuses every global send. */
  payeeControls?: string | undefined;
  /** Owner-published exchange payment allowance (JSON). Blank refuses every global send. */
  exchangeAllowance?: string | undefined;
  /** Owner-published proof-upload limits (JSON). Blank refuses an upload. */
  proofLimits?: string | undefined;
  /** `BANK_GLOBAL_HOLD_CANCEL_HOURS`: how long a global send may stay on hold before it is cancelled. Blank, never. */
  holdCancelHours?: string;
  /** `BANK_GLOBAL_REFUND_FEE`: the fee on refunding a global send the rail returned. Blank refuses; only zero refunds. */
  refundFee?: string;
}

export function composePersonalPayArea(
  root: BankRoot,
  made: { readonly spaces: SpaceService },
  options: PersonalPayAreaOptions,
): PersonalPayAreaServices {
  const { sql, ledger } = root;
  const bills = new BillPayService(sql, ledger, made.spaces, options.bills ?? emptyBillPorts());
  const globalSend = new GlobalSendService(
    sql,
    ledger,
    made.spaces,
    options.global ?? emptyGlobalPorts(),
    options.sendFieldRules,
    options.payeeControls,
    options.exchangeAllowance,
    root.receiptSecret,
    options.refundFee,
  );
  const globalHolds = new GlobalHoldService(sql, globalSend, options.proofLimits, () =>
    options.holdCancelHours !== undefined ? options.holdCancelHours : process.env[BANK_GLOBAL_HOLD_CANCEL_HOURS_ENV],
  );
  globalSend.screenWith((sendId) => globalHolds.screen(sendId));
  return { bills, globalSend, globalHolds };
}
