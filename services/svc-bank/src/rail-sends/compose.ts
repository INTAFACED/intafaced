import type { BankRoot } from '../bank-root.js';
import type { SpaceService } from '../spaces/space-service.js';
import { BANK_PAYEE_COOLING_HOURS_ENV, PayeeService } from './payees.js';
import { RailSendService } from './rail-sends.js';

/** Sends to a bank account over a bank rail, and their recipient book. An area of svc-bank (`area-chain.ts`). */
export interface RailSendsServices {
  /** BK-xfer-02: send to a bank account over a bank rail. Kept refused with `rail.bank`; nothing is held or posted. */
  readonly railSends: RailSendService;
  /** BK-xfer-06: the recipient book for bank rails, with the owner's cooling-off on a new recipient. */
  readonly railPayees: PayeeService;
}

export interface RailSendsServiceOptions {
  /** `BANK_PAYEE_COOLING_HOURS`: how long a new bank-rail recipient waits. Blank refuses; zero is no wait. */
  payeeCoolingHours?: string;
}

export function composeRailSendsArea(
  root: BankRoot,
  made: { readonly spaces: SpaceService },
  options: RailSendsServiceOptions,
): RailSendsServices {
  // The owner's window for a new recipient: a value passed in wins, otherwise the live env. Blank refuses a send.
  const railPayees = new PayeeService(root.sql, () =>
    options.payeeCoolingHours !== undefined ? options.payeeCoolingHours : process.env[BANK_PAYEE_COOLING_HOURS_ENV],
  );
  return { railSends: new RailSendService(root.sql, made.spaces, railPayees), railPayees };
}
