/**
 * Historical market data downloads (RC-cex-spot-05; J-cex-spot-15 #10): versioned schemas, dataset manifests,
 * completeness metrics, sequence gaps, append-only corrections and download addresses for trades, candles and book
 * snapshots. Browser-safe (zod only). Amounts stay decimal strings.
 */
import { z } from 'zod';

export const HISTORY_DATASETS_PATH = '/api/v1/history/datasets' as const;
export const HISTORY_SCHEMAS_PATH = '/api/v1/history/schemas' as const;
export const HISTORY_DOWNLOAD_ROUTE = '/api/v1/history/datasets/:id/download' as const;

export const HISTORY_KINDS = ['trades', 'candles', 'book_snapshots'] as const;
export type HistoryDatasetKind = (typeof HISTORY_KINDS)[number];
export const historyKindSchema = z.enum(HISTORY_KINDS);

export const HISTORY_SCHEMA_VERSION = '1' as const;
export const HISTORY_PROVENANCE = "this venue's own matching sequence" as const;

/** Refused when TRADE_HISTORY_BOOK_INTERVAL_MS is blank and book snapshot datasets are requested or built. */
export const TRADE_HISTORY_BOOK_INTERVAL_UNSET = 'trade.history_book_interval_unset' as const;
/** Refused with 404 when a dataset id does not exist. */
export const TRADE_HISTORY_DATASET_NOT_FOUND = 'trade.history_dataset_not_found' as const;

export const historyGapSchema = z.object({
  fromSequence: z.number().int(),
  toSequence: z.number().int(),
});
export type HistoryGap = z.infer<typeof historyGapSchema>;

export const historyCorrectionSchema = z.object({
  id: z.string(),
  sequenceFrom: z.number().int(),
  sequenceTo: z.number().int(),
  reason: z.string(),
  supersedingDatasetId: z.string(),
  supersedingSha256: z.string(),
  createdAt: z.string(),
});
export type HistoryCorrection = z.infer<typeof historyCorrectionSchema>;

export const historyDatasetManifestSchema = z.object({
  id: z.string(),
  key: z.string(),
  symbol: z.string(),
  kind: historyKindSchema,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  windowStart: z.string(),
  windowEnd: z.string(),
  schemaVersion: z.string(),
  format: z.literal('ndjson'),
  compression: z.literal('gzip'),
  rowCount: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  firstSequence: z.number().int().nullable(),
  lastSequence: z.number().int().nullable(),
  completenessPct: z.string(),
  gaps: z.array(historyGapSchema),
  provenance: z.string(),
  generatedAt: z.string(),
  supersededBy: z.string().nullable(),
  corrections: z.array(historyCorrectionSchema),
  downloadPath: z.string(),
});
export type HistoryDatasetManifest = z.infer<typeof historyDatasetManifestSchema>;

export const historyDatasetsResponseSchema = z.object({
  datasets: z.array(historyDatasetManifestSchema),
  bookIntervalMs: z.number().int().positive().nullable(),
  bookSnapshotsStatus: z.enum(['configured', 'unset']),
  bookSnapshotsCode: z.string().nullable(),
});
export type HistoryDatasetsResponse = z.infer<typeof historyDatasetsResponseSchema>;

export const historySchemaFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
});

export const historySchemaEntrySchema = z.object({
  kind: historyKindSchema,
  schemaVersion: z.string(),
  format: z.literal('ndjson'),
  compression: z.literal('gzip'),
  checksumAlgorithm: z.literal('sha256'),
  provenance: z.string(),
  fields: z.array(historySchemaFieldSchema),
});

export const historySchemasResponseSchema = z.object({
  provenance: z.string(),
  schemas: z.array(historySchemaEntrySchema),
});
export type HistorySchemasResponse = z.infer<typeof historySchemasResponseSchema>;
