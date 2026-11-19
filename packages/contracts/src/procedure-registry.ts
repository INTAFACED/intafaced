// Written by `procedures:write` (scripts/procedure-registry.mjs) from every `defineProcedure` in src/. Do not edit by hand.
import { BANK_SPACES_LIST } from './bank-spaces-list.js';
import { LEDGER_HISTORY_PAGE } from './ledger-history-page.js';
import {
  TAX_HEALTH,
  TAX_LOT_BOOK,
  TAX_PNL_OVER_TIME,
  TAX_MISSING_BASIS,
  TAX_BASIS_OVERRIDE_SET,
  TAX_BASIS_OVERRIDE_REMOVE,
  TAX_SET_LOT_METHOD,
  TAX_SET_DAY_METHOD,
  TAX_PICK_SALE_LOT,
  TAX_SET_INCLUDE_TRANSFERS,
  TAX_EXPORT_PREVIEW,
  TAX_EXPORT_PACK,
} from './tax-procedures.js';
import type { ProcedureRecord } from './procedure.js';

/** Every call recorded in this package. `procedures.schema.json` is written from this list. */
export const CONTRACT_PROCEDURES: readonly ProcedureRecord[] = [
  BANK_SPACES_LIST,
  LEDGER_HISTORY_PAGE,
  TAX_HEALTH,
  TAX_LOT_BOOK,
  TAX_PNL_OVER_TIME,
  TAX_MISSING_BASIS,
  TAX_BASIS_OVERRIDE_SET,
  TAX_BASIS_OVERRIDE_REMOVE,
  TAX_SET_LOT_METHOD,
  TAX_SET_DAY_METHOD,
  TAX_PICK_SALE_LOT,
  TAX_SET_INCLUDE_TRANSFERS,
  TAX_EXPORT_PREVIEW,
  TAX_EXPORT_PACK,
];
