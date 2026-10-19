/** Machine-readable refuses. The code leads the tRPC message so IxState can quote it. */
export const TAX_JURISDICTION_UNMAPPED = 'tax.jurisdiction_unmapped' as const;
export const TAX_JURISDICTION_MAP_INVALID = 'tax.jurisdiction_map_invalid' as const;
export const TAX_LOT_METHOD_REQUIRED = 'tax.lot_method_required' as const;
export const TAX_LEDGER_UNWIRED = 'tax.ledger_unwired' as const;
export const TAX_LEDGER_HISTORY_UNAVAILABLE = 'tax.ledger_history_unavailable' as const;
export const TAX_DATA_LAKE_UNAVAILABLE = 'tax.data_lake_unavailable' as const;
export const TAX_INDEXER_UNAVAILABLE = 'tax.indexer_unavailable' as const;
/** URL present is not a live lake. This process never probes TSDB. */
export const TAX_DATA_LAKE_UNPROBED = 'tax.data_lake_unprobed' as const;
/** URL present is not a live indexer. This process never probes chain lots. */
export const TAX_INDEXER_UNPROBED = 'tax.indexer_unprobed' as const;
export const TAX_COST_BASIS_UNAVAILABLE = 'tax.cost_basis_unavailable' as const;
export const TAX_CLOSED_LOTS_UNINDEXED = 'tax.closed_lots_unindexed' as const;
export const TAX_LOT_UNDERFLOW = 'tax.lot_underflow' as const;
/** Completeness is OWNER map. The engine never certifies a complete export. */
export const TAX_EXPORT_INCOMPLETE = 'tax.export_incomplete' as const;
/** Ledger history window is OWNER env. Blank never invents 10 years. */
export const TAX_HISTORY_YEARS_UNSET = 'tax.history_years_unset' as const;

/** Part of the fill history could not be read, so the book may miss lots. Named, never silently short. */
export const TAX_LOT_BOOK_INCOMPLETE = 'tax.lot_book_incomplete' as const;
/** More is open in lots than the customer holds: coins left another way, so their cost is unknown. */
export const TAX_LOT_BOOK_UNRECONCILED = 'tax.lot_book_unreconciled' as const;

export type TaxRefuseCode =
  | typeof TAX_JURISDICTION_UNMAPPED
  | typeof TAX_JURISDICTION_MAP_INVALID
  | typeof TAX_LOT_METHOD_REQUIRED
  | typeof TAX_LEDGER_UNWIRED
  | typeof TAX_LEDGER_HISTORY_UNAVAILABLE
  | typeof TAX_DATA_LAKE_UNAVAILABLE
  | typeof TAX_INDEXER_UNAVAILABLE
  | typeof TAX_DATA_LAKE_UNPROBED
  | typeof TAX_INDEXER_UNPROBED
  | typeof TAX_COST_BASIS_UNAVAILABLE
  | typeof TAX_CLOSED_LOTS_UNINDEXED
  | typeof TAX_LOT_UNDERFLOW
  | typeof TAX_EXPORT_INCOMPLETE
  | typeof TAX_HISTORY_YEARS_UNSET
  | typeof TAX_LOT_BOOK_INCOMPLETE
  | typeof TAX_LOT_BOOK_UNRECONCILED;

export class TaxError extends Error {
  readonly code: TaxRefuseCode;

  constructor(code: TaxRefuseCode, message: string) {
    super(message);
    this.name = 'TaxError';
    this.code = code;
  }
}
