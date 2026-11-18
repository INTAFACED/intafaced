import { BANK_SPACES_LIST } from './bank-spaces-list.js';
import type { ProcedureRecord } from './procedure.js';

/** Every call recorded in this package (`defineProcedure`). `procedures.schema.json` is written from this list. */
export const CONTRACT_PROCEDURES: readonly ProcedureRecord[] = [BANK_SPACES_LIST];
