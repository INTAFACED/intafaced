// Written by `procedures:write` (scripts/procedure-registry.mjs) from every `defineProcedure` in src/. Do not edit by hand.
import { LEDGER_HISTORY_PAGE } from './history-page-record.js';
import { LEDGER_POST_RECIPE } from './post-recipe-record.js';
import type { ProcedureRecord } from '@intafaced/contracts/procedure';

/** Every call recorded in this package. `procedures/<service>.schema.json` is written from this list. */
export const LEDGER_PROCEDURES: readonly ProcedureRecord[] = [LEDGER_HISTORY_PAGE, LEDGER_POST_RECIPE];
