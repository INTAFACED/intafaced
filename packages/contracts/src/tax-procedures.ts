import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT, type Refusals } from './procedure.js';
import {
  basisOverrideRemoveInputSchema,
  basisOverrideSetInputSchema,
  basisWriteResultSchema,
  lotBookInputSchema,
  lotBookSchema,
  lotChoiceSavedSchema,
  missingBasisSchema,
  pickSaleLotInputSchema,
  pnlOverTimeInputSchema,
  pnlOverTimeSchema,
  setDayMethodInputSchema,
  setIncludeTransfersInputSchema,
  setLotMethodInputSchema,
} from './tax-lot-book.js';

/**
 * svc-tax's whole call surface, one record per call. The service mounts each from here
 * (`mountRecords`), so its path, guard, input, output and named refusals are this file, not its router.
 */

/** The methods a tax export takes (no AVERAGE: an export names one matching rule per sale). svc-tax's `LOT_METHODS`. */
export const TAX_EXPORT_LOT_METHODS = ['FIFO', 'LIFO', 'HIFO'] as const;
const exportLotMethod = z.enum(TAX_EXPORT_LOT_METHODS);

const lakeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('absent'), code: z.enum(['tax.data_lake_unavailable', 'tax.indexer_unavailable']) }),
  z.object({ status: z.literal('configured'), code: z.enum(['tax.data_lake_unprobed', 'tax.indexer_unprobed']) }),
]);

const yearLineSchema = z.object({
  kind: z.enum(['fill', 'convert']),
  postedAt: z.string(),
  assetId: assetIdSchema,
  qty: z.string(),
  fee: z.string().nullable(),
  makerRebate: z.string().nullable(),
  costBasis: z.string().nullable(),
  proceeds: z.string().nullable(),
  realized: z.string().nullable(),
});

const subAccountYearSchema = z.object({
  subAccountId: z.string(),
  lines: z.array(yearLineSchema),
  realized: z.string().nullable(),
  residuals: z.array(z.string()),
});

export const taxExportPreviewSchema = z.object({
  empty: z.boolean(),
  complete: z.literal(false),
  lotMethod: exportLotMethod,
  jurisdiction: z.string(),
  lotCount: z.number().int().nonnegative(),
  realized: z.string().nullable(),
  unrealized: z.string().nullable(),
  lake: lakeSchema,
  indexer: lakeSchema,
  residuals: z.array(z.string()),
  subAccountBooks: z.enum(['unwired', 'read']),
  subAccounts: z.array(subAccountYearSchema),
});

export const taxExportInputSchema = z.object({
  lotMethod: exportLotMethod,
  /** Completeness is OWNER map. `true` is named-refused — never invent jurisdictions. */
  complete: z.boolean().optional(),
});

export const taxExportPackSchema = taxExportPreviewSchema.extend({
  filename: z.string().min(1),
  mime: z.literal('application/json'),
  bodyBase64: z.string().min(1),
});

const TAX_READ = { caller: 'scope', scope: 'tax:read', module: 'tax', plane: 'fiat' } as const;
const TAX_WRITE = { caller: 'scope', scope: 'tax:write', module: 'tax', plane: 'fiat' } as const;

/** Every svc-tax refusal is a `TaxError`, sent as PRECONDITION_FAILED with the code leading the message (`router.ts`). */
const refuse = (...codes: string[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, 'PRECONDITION_FAILED' as const])));

const BOOK_READ = ['tax.lot_method_required', 'tax.ledger_unwired', 'tax.ledger_history_unavailable', 'tax.basis_price_invalid'];
const CHOICE_WRITE = ['tax.basis_store_unwired', 'tax.lot_method_required'];
const EXPORT = [
  'tax.jurisdiction_unmapped',
  'tax.jurisdiction_map_invalid',
  'tax.export_incomplete',
  'tax.history_years_unset',
  ...BOOK_READ,
];

const base = { service: 'svc-tax', module: 'tax', transport: 'trpc' } as const;

const EXPORT_SAMPLES = [
  { verdict: 'accept', input: { lotMethod: 'HIFO' } },
  // Accepted on the wire; the export then refuses it by name (`tax.export_incomplete`), never as a malformed input.
  { verdict: 'accept', input: { lotMethod: 'FIFO', complete: true } },
  { verdict: 'refuse', input: { lotMethod: 'AVERAGE' } },
  { verdict: 'refuse', input: {} },
] as const;

export const TAX_HEALTH = defineProcedure({
  ...base,
  name: 'tax.health',
  kind: 'query',
  path: 'health',
  access: { caller: 'public' },
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({ ok: z.literal(true), service: z.literal('svc-tax') }),
  samples: [{ verdict: 'accept' }],
});

export const TAX_LOT_BOOK = defineProcedure({
  ...base,
  name: 'tax.lotBook',
  kind: 'query',
  path: 'lotBook',
  access: TAX_READ,
  refusals: refuse(...BOOK_READ),
  input: lotBookInputSchema,
  output: lotBookSchema,
  samples: [
    { verdict: 'accept' },
    { verdict: 'accept', input: {} },
    { verdict: 'accept', input: { method: 'HIFO' } },
    { verdict: 'refuse', input: { method: 'NEWEST' } },
    { verdict: 'refuse', input: { method: 'FIFO', extra: 1 } },
  ],
});

export const TAX_PNL_OVER_TIME = defineProcedure({
  ...base,
  name: 'tax.pnlOverTime',
  kind: 'query',
  path: 'pnlOverTime',
  access: TAX_READ,
  refusals: refuse(
    ...BOOK_READ,
    'tax.pnl_range_invalid',
    'tax.pnl_range_too_long',
    'tax.pnl_prices_unavailable',
    'tax.pnl_breakdown_mismatch',
  ),
  input: pnlOverTimeInputSchema,
  output: pnlOverTimeSchema,
  samples: [
    { verdict: 'accept', input: { from: '2026-01-01T00:00:00Z', utcOffsetMinutes: 60 } },
    { verdict: 'accept', input: { from: '2026-01-01T00:00:00+08:00', to: '2026-02-01T00:00:00.000Z', utcOffsetMinutes: -840 } },
    { verdict: 'refuse', input: { from: '2026-01-01T00:00:00Z', utcOffsetMinutes: 900 } },
    { verdict: 'refuse', input: { from: '2026-01-01T00:00:00Z', utcOffsetMinutes: 1.5 } },
    { verdict: 'refuse', input: { from: '2026-01-01', utcOffsetMinutes: 0 } },
    { verdict: 'refuse', input: { utcOffsetMinutes: 0 } },
  ],
});

export const TAX_MISSING_BASIS = defineProcedure({
  ...base,
  name: 'tax.missingBasis',
  kind: 'query',
  path: 'missingBasis',
  access: TAX_READ,
  refusals: refuse(...BOOK_READ),
  input: lotBookInputSchema,
  output: missingBasisSchema,
  samples: [{ verdict: 'accept' }, { verdict: 'accept', input: { method: 'LIFO' } }, { verdict: 'refuse', input: { method: 7 } }],
});

export const TAX_BASIS_OVERRIDE_SET = defineProcedure({
  ...base,
  name: 'tax.basisOverride.set',
  kind: 'mutation',
  path: 'basisOverride.set',
  access: TAX_WRITE,
  refusals: refuse(
    ...BOOK_READ,
    'tax.basis_store_unwired',
    'tax.basis_price_unset',
    'tax.basis_date_unset',
    'tax.basis_date_invalid',
    'tax.basis_note_unset',
    'tax.basis_lot_unknown',
    'tax.manual_position_incomplete',
    'portfolio.basis_override_not_allowed',
  ),
  input: basisOverrideSetInputSchema,
  output: basisWriteResultSchema,
  samples: [
    { verdict: 'accept', input: { lotId: 'l1', pricePerUnit: '1.5', date: '2026-01-01', sourceNote: 'n' } },
    { verdict: 'accept', input: { lotId: 'm1', pricePerUnit: '1.5', date: '2026-01-01', sourceNote: 'n', assetId: 'BTC', qty: '2' } },
    { verdict: 'refuse', input: { lotId: 'l1', pricePerUnit: 1.5, date: '2026-01-01', sourceNote: 'n' } },
    { verdict: 'refuse', input: { lotId: 'l1', pricePerUnit: '1.5', date: '2026-01-01' } },
  ],
});

export const TAX_BASIS_OVERRIDE_REMOVE = defineProcedure({
  ...base,
  name: 'tax.basisOverride.remove',
  kind: 'mutation',
  path: 'basisOverride.remove',
  access: TAX_WRITE,
  refusals: refuse('tax.basis_store_unwired', 'tax.basis_lot_unknown', 'tax.basis_override_absent', 'tax.basis_price_invalid'),
  input: basisOverrideRemoveInputSchema,
  output: basisWriteResultSchema,
  samples: [
    { verdict: 'accept', input: { lotId: 'l1' } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { lotId: 'l1', extra: 1 } },
  ],
});

export const TAX_SET_LOT_METHOD = defineProcedure({
  ...base,
  name: 'tax.setLotMethod',
  kind: 'mutation',
  path: 'setLotMethod',
  access: TAX_WRITE,
  refusals: refuse(...CHOICE_WRITE),
  input: setLotMethodInputSchema,
  output: lotChoiceSavedSchema,
  samples: [
    { verdict: 'accept', input: { assetId: null, method: 'FIFO' } },
    { verdict: 'accept', input: { assetId: 'BTC', method: null } },
    { verdict: 'refuse', input: { assetId: 'B-T', method: 'FIFO' } },
    { verdict: 'refuse', input: { method: 'FIFO' } },
  ],
});

export const TAX_SET_DAY_METHOD = defineProcedure({
  ...base,
  name: 'tax.setDayMethod',
  checks: { 'tax.day_exists': { at: 'input.day', says: 'the day is a real calendar day (no 30 February)' } },
  kind: 'mutation',
  path: 'setDayMethod',
  access: TAX_WRITE,
  refusals: refuse(...CHOICE_WRITE),
  input: setDayMethodInputSchema,
  output: lotChoiceSavedSchema,
  samples: [
    { verdict: 'accept', input: { day: '2026-01-01', assetId: 'BTC', method: 'LIFO' } },
    { verdict: 'accept', input: { day: '2024-02-29', assetId: null, method: null } },
    { verdict: 'refuse', input: { day: '2026-02-30', assetId: null, method: 'FIFO' }, by: 'tax.day_exists' },
    { verdict: 'refuse', input: { day: '2026-1-01', assetId: null, method: 'FIFO' } },
  ],
});

export const TAX_PICK_SALE_LOT = defineProcedure({
  ...base,
  name: 'tax.pickSaleLot',
  kind: 'mutation',
  path: 'pickSaleLot',
  access: TAX_WRITE,
  refusals: refuse(...CHOICE_WRITE, ...BOOK_READ, 'tax.lot_pick_invalid'),
  input: pickSaleLotInputSchema,
  output: lotChoiceSavedSchema,
  samples: [
    { verdict: 'accept', input: { saleTxId: 's1', assetId: 'BTC', lotId: null } },
    { verdict: 'accept', input: { saleTxId: 's1', assetId: 'BTC', lotId: 'l1' } },
    { verdict: 'refuse', input: { saleTxId: '', assetId: 'BTC', lotId: null } },
    { verdict: 'refuse', input: { saleTxId: 's1', assetId: 'BTC', lotId: '' } },
  ],
});

export const TAX_SET_INCLUDE_TRANSFERS = defineProcedure({
  ...base,
  name: 'tax.setIncludeTransfers',
  kind: 'mutation',
  path: 'setIncludeTransfers',
  access: TAX_WRITE,
  refusals: refuse('tax.basis_store_unwired'),
  input: setIncludeTransfersInputSchema,
  output: lotChoiceSavedSchema,
  samples: [
    { verdict: 'accept', input: { include: true } },
    { verdict: 'accept', input: { include: null } },
    { verdict: 'refuse', input: { include: 'yes' } },
  ],
});

export const TAX_EXPORT_PREVIEW = defineProcedure({
  ...base,
  name: 'tax.exportPreview',
  kind: 'query',
  path: 'exportPreview',
  access: TAX_READ,
  refusals: refuse(...EXPORT),
  input: taxExportInputSchema,
  output: taxExportPreviewSchema,
  samples: EXPORT_SAMPLES,
});

/** A read, but a mutation on the wire today (its reply is a file): kept as it is, bugs included. */
export const TAX_EXPORT_PACK = defineProcedure({
  ...base,
  name: 'tax.exportPack',
  kind: 'mutation',
  path: 'exportPack',
  access: TAX_READ,
  refusals: refuse(...EXPORT),
  input: taxExportInputSchema,
  output: taxExportPackSchema,
  samples: EXPORT_SAMPLES,
});

export const TAX_PROCEDURES = [
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
] as const;
