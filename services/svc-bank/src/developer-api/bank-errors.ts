import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `developer-api/` throws, and what a caller is told for each (see `../errors.ts`). */
export const DEVELOPER_API_BANK_ERRORS = {
  /** No quote by that id is the caller's. */
  'bank.quote_not_found': 'NOT_FOUND',
  /** The quote is past its valid-until: ask for a new one. Nothing was moved. */
  'bank.quote_expired': 'CONFLICT',
  /** The partner does not say what the move costs, so it is not made on an unknown figure. Nothing was moved. */
  'bank.partner_fee_unknown': 'PRECONDITION_FAILED',
  /** The same dedupe id or idempotency key was used before for a different instruction. Nothing was moved. */
  'bank.idempotency_conflict': 'CONFLICT',
  /** A webhook URL that is not https, points inside our network, or does not resolve. Nothing was saved. */
  'bank.webhook_url_invalid': 'BAD_REQUEST',
} as const satisfies BankErrorTable;
