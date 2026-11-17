import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `sorter/` throws, and what a caller is told for each (see `../errors.ts`). */
export const SORTER_BANK_ERRORS = {
  /** A sorter that cannot be: no spaces or too many, a space twice, a share outside 1 to 10000 basis points, shares over 100%, or the account itself (BK-pots-03). */
  'bank.sorter_invalid': 'BAD_REQUEST',
  /** The account already sorts this asset; cancel that sorter first (BK-pots-03). */
  'bank.sorter_exists': 'CONFLICT',
  /** The sorter id is already taken by a sorter on different terms (BK-pots-03). */
  'bank.sorter_conflict': 'CONFLICT',
  /** No such sorter of the caller's; another person's reads the same (BK-pots-03). */
  'bank.sorter_not_found': 'NOT_FOUND',
  /** One split of a sorted credit failed without a typed code (BK-pots-03). */
  'bank.sorter_split_failed': 'CONFLICT',
} as const satisfies BankErrorTable;
