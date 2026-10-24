import { LedgerError } from '@intafaced/ledger-client';

/** A refused operator reconciliation control. `code` is the refusal the caller sees. */
export class ReconciliationControlError extends LedgerError {
  constructor(code: string) {
    super(code, code);
    this.name = 'ReconciliationControlError';
  }
}
