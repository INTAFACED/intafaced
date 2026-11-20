import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `onboarding/` throws, and what a caller is told for each (see `../errors.ts`). */
export const ONBOARDING_BANK_ERRORS = {
  /** An answer's file type is not one the owner allows. */
  'bank.info_request_type_not_allowed': 'BAD_REQUEST',
  /** An answer's file is over the owner's size cap. */
  'bank.info_request_too_large': 'BAD_REQUEST',
  /** An answer's file is empty or not base64. */
  'bank.info_request_file_invalid': 'BAD_REQUEST',
} as const satisfies BankErrorTable;
