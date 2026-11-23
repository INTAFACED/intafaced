import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `spaces/` throws, and what a caller is told for each (see `../errors.ts`). */
export const SPACES_BANK_ERRORS = {
  /**
   * A paycheck deposit has no rail. The missing piece is an outside company,
   * the paycheck rail. This is not business payroll and it posts nothing.
   */
  'bank.no_paycheck_rail': 'PRECONDITION_FAILED',
  /** An invite accepted after its owner-set lifetime. */
  'bank.invite_expired': 'CONFLICT',
  /** No unanswered invite of the caller's has this id, or they declined it. */
  'bank.invite_not_found': 'NOT_FOUND',
  /** No active account has the handle or email asked for: unknown, frozen and closed are one answer. */
  'bank.invitee_not_found': 'NOT_FOUND',
  /** A pot is shared with the owner-set number of people, open invites included. */
  'bank.shared_pot_full': 'CONFLICT',
  /** An invite to oneself, to a member or someone already invited, an invite id reused, or an answer to an answered invite. */
  'bank.shared_pot_invalid': 'BAD_REQUEST',
  /** The customer already has a space with this name in this currency (`spaces_user_asset_name_idx`); rename and retry. */
  'bank.space_name_taken': 'CONFLICT',
  /** An early unlock was asked for, or withdrawn, on a pot that is not locked now (BK-pots-02). */
  'bank.space_not_locked': 'CONFLICT',
} as const satisfies BankErrorTable;
