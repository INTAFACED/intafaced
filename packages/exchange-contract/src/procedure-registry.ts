// Written by `procedures:write` (scripts/procedure-registry.mjs) from every `defineProcedure` in src/. Do not edit by hand.
import { MATCHING_SUBMIT_ORDER } from './matching-submit-order.js';
import type { ProcedureRecord } from '@intafaced/contracts/procedure';

/** Every call recorded in this package. `procedures.schema.json` is written from this list. */
export const EXCHANGE_PROCEDURES: readonly ProcedureRecord[] = [MATCHING_SUBMIT_ORDER];
