import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `activity/` throws, and what a caller is told for each (see `../errors.ts`). */
export const ACTIVITY_BANK_ERRORS = {
  /** The activity id is not in this customer's history. */
  'bank.activity_not_found': 'NOT_FOUND',
  /** Lookup stopped before history ended, so absence is not proven. */
  'bank.activity_lookup_bounded': 'PRECONDITION_FAILED',
  /** A note command id was reused with different text. */
  'bank.activity_note_conflict': 'CONFLICT',
  /** A note write carried neither a note nor a report description. */
  'bank.activity_note_empty': 'BAD_REQUEST',
  /** A dispute id was reused with a different reason or transaction. */
  'bank.activity_dispute_conflict': 'CONFLICT',
  /** This customer already has an open dispute on that transaction. */
  'bank.activity_dispute_exists': 'CONFLICT',
  /** A saved activity filter name is blank or longer than 60 characters. */
  'bank.activity_filter_name_invalid': 'BAD_REQUEST',
  /** A saved activity filter carries no filter at all. */
  'bank.activity_filter_empty': 'BAD_REQUEST',
  /** That saved filter name already holds a different filter. */
  'bank.activity_filter_conflict': 'CONFLICT',
  /** Saved filter page size unpublished. Blank is not 50. */
  'bank.activity_filter_limit_unset': 'BAD_REQUEST',
  /** The partner's history cannot answer this filter here; nothing is silently ignored. */
  'bank.partner_history_filter_unsupported': 'BAD_REQUEST',
} as const satisfies BankErrorTable;
