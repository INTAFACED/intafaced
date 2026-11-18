import type { ProcedureRecord } from '@intafaced/contracts/procedure';
import { MATCHING_SUBMIT_ORDER } from './matching-submit-order.js';

/** Every call recorded in this package (`defineProcedure`). `procedures.schema.json` is written from this list. */
export const EXCHANGE_PROCEDURES: readonly ProcedureRecord[] = [MATCHING_SUBMIT_ORDER];
