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

/** Short or long term is a tax rule value the owner has not published; only days held is shown. */
export const TAX_TERM_RULE_UNSET = 'tax.term_rule_unset' as const;
/** How a deposit's cost is set (its value on arrival, or entered by the customer) is an owner policy that is not set. */
export const TAX_DEPOSIT_BASIS_POLICY_UNSET = 'tax.deposit_basis_policy_unset' as const;
/** No candle priced a coin at the time it arrived, so its value then is not known. */
export const TAX_PRICE_AT_TIME_UNAVAILABLE = 'tax.price_at_time_unavailable' as const;
/** A lot the customer picked for a sale was not open when the sale happened, so the sale's method decided instead. */
export const TAX_LOT_PICK_UNUSABLE = 'tax.lot_pick_unusable' as const;
/** A lot pick names a sale or a lot that is not in the caller's book, or a lot that arrived after the sale. */
export const TAX_LOT_PICK_INVALID = 'tax.lot_pick_invalid' as const;
/** A price was entered for a lot that is not in the caller's book. */
export const TAX_BASIS_LOT_UNKNOWN = 'tax.basis_lot_unknown' as const;
/** A price was entered for a lot whose cost comes from our own records: our figure wins. */
export const TAX_BASIS_OVERRIDE_NOT_ALLOWED = 'tax.basis_override_not_allowed' as const;
/** The settings store is not connected, so a cost-basis choice cannot be saved. Reads use the product default. */
export const TAX_DATABASE_URL_UNSET = 'tax.database_url_unset' as const;
/** The saved choices could not be read for this answer; the product default was used and the book says so. */
export const TAX_CHOICES_UNAVAILABLE = 'tax.choices_unavailable' as const;
/** DATABASE_URL is set but its pool size is not; blank is not 10. */
export const TAX_DATABASE_POOL_MAX_UNSET = 'tax.database_pool_max_unset' as const;

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
  | typeof TAX_LOT_BOOK_UNRECONCILED
  | typeof TAX_TERM_RULE_UNSET
  | typeof TAX_DEPOSIT_BASIS_POLICY_UNSET
  | typeof TAX_PRICE_AT_TIME_UNAVAILABLE
  | typeof TAX_LOT_PICK_UNUSABLE
  | typeof TAX_LOT_PICK_INVALID
  | typeof TAX_BASIS_LOT_UNKNOWN
  | typeof TAX_BASIS_OVERRIDE_NOT_ALLOWED
  | typeof TAX_DATABASE_URL_UNSET
  | typeof TAX_DATABASE_POOL_MAX_UNSET
  | typeof TAX_CHOICES_UNAVAILABLE;

export class TaxError extends Error {
  readonly code: TaxRefuseCode;

  constructor(code: TaxRefuseCode, message: string) {
    super(message);
    this.name = 'TaxError';
    this.code = code;
  }
}
