// Written by `procedures:write` (scripts/procedure-registry.mjs) from every `defineProcedure` in src/. Do not edit by hand.
import { LEDGER_HISTORY_PAGE } from './history-page-record.js';

import { LEDGER_OPERATOR_REVERSE } from './operator-reverse-record.js';

import { LEDGER_POST_RECIPE } from './post-recipe-record.js';

import type { ProcedureRecord } from '@intafaced/contracts/procedure';

const part_history_page_record: readonly ProcedureRecord[] = [LEDGER_HISTORY_PAGE];

const part_operator_reverse_record: readonly ProcedureRecord[] = [LEDGER_OPERATOR_REVERSE];

const part_post_recipe_record: readonly ProcedureRecord[] = [LEDGER_POST_RECIPE];

/** Every call recorded in this package. `procedures/<service>.schema.json` is written from this list. */
export const LEDGER_PROCEDURES: readonly ProcedureRecord[] = [
  ...part_history_page_record,
  ...part_operator_reverse_record,
  ...part_post_recipe_record,
];
