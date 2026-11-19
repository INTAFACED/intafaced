import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `deposits/` throws, and what a caller is told for each (see `../errors.ts`). */
export const DEPOSITS_BANK_ERRORS = {
  /** Custody published a catalogue or address this service will not repeat. */
  'bank.deposit_catalogue_invalid': 'PRECONDITION_FAILED',
  /** The asset or network is not in the published catalogue. */
  'bank.deposit_asset_unpublished': 'PRECONDITION_FAILED',
  /** The owner switched deposits of this asset on this network off: no address is issued. */
  'bank.deposit_network_halted': 'PRECONDITION_FAILED',
  /** Custody returned more incoming deposits than this door will publish. None are dropped. */
  'bank.deposit_pending_unbounded': 'PRECONDITION_FAILED',
  /** Every address number (up to 9999) for this person, asset and network has been used; numbers are never reused. */
  'bank.deposit_address_numbers_used': 'PRECONDITION_FAILED',
  /** No deposit address of this person has that asset, network and number. */
  'bank.deposit_address_not_found': 'NOT_FOUND',
  /** A deposit address label must be 1 to 40 characters with no space at either end, or empty to clear it. */
  'bank.deposit_address_label_invalid': 'BAD_REQUEST',
} as const satisfies BankErrorTable;
