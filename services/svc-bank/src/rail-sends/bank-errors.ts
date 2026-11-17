import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `rail-sends/` throws, and what a caller is told for each (see `../errors.ts`). */
export const RAIL_SENDS_BANK_ERRORS = {
  /** A send over a bank rail with a recipient field that rail's form refuses (the message names the field). Nothing kept. */
  'bank.rail_send_invalid': 'BAD_REQUEST',
  /** A send-over-a-bank-rail request id already kept on other terms, or by someone else. Nothing changed. */
  'bank.rail_send_conflict': 'BAD_REQUEST',
  /** A send over a bank rail for more than the space's available balance, read from the ledger. Nothing kept. */
  'bank.rail_send_over_available': 'PRECONDITION_FAILED',
  /** A saved bank-rail recipient that is not the caller's, was removed, or does not exist. Not found and not yours read the same. */
  'bank.payee_not_found': 'NOT_FOUND',
  /** The recipient is inside the owner's cooling-off window; the message names when it ends. Nothing kept. */
  'bank.payee_cooling_active': 'PRECONDITION_FAILED',
  /** An invite emails the recipient a link; no email delivery is connected, so it is refused by name. */
  'bank.payee_invite_unwired': 'PRECONDITION_FAILED',
} as const satisfies BankErrorTable;
