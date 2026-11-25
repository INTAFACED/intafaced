/**
 * Historical market data datasets (RC-cex-spot-05; J-cex-spot-15 #10).
 *
 * Builds deterministic gzipped NDJSON files with SHA-256 checksums, sequence-based completeness and gap lists, and
 * append-only corrections for trades (from `trade.fills` via `publicTapePrint`), 1m candles (from real taker fills),
 * and book snapshots (captured at the owner-published `TRADE_HISTORY_BOOK_INTERVAL_MS`).
 *
 * Public market data only: no account identifier and no order id ever appear in a dataset row.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  HISTORY_PROVENANCE,
  HISTORY_SCHEMA_VERSION,
  TRADE_HISTORY_BOOK_INTERVAL_UNSET,
  TRADE_HISTORY_DATASET_NOT_FOUND,
  historyGapSchema,
  historyKindSchema,
  type HistoryCorrection,
  type HistoryDatasetKind,
  type HistoryDatasetManifest,
  type HistoryGap,
  type HistorySchemasResponse,
} from '@intafaced/contracts/trade-history';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { publicTapePrint } from './public-tape.js';
import type { EngineDepth } from './matching-client.js';
import type { Market, OrderSide } from './types.js';
import { TradeError } from './types.js';

/** Business key for a day's dataset. Rerunning the job for the same day targets this exact key. */
export function datasetKeyFor(symbol: string, kind: HistoryDatasetKind, day: string): string {
  return `history:${symbol}:${kind}:${day}`;
}

/** Business key for an append-only superseding dataset linked from a correction row. */
export function correctionDatasetKeyFor(input: {
  readonly symbol: string;
  readonly kind: HistoryDatasetKind;
  readonly day: string;
  readonly correctionTag: string;
}): string {
  return `history:${input.symbol}:${input.kind}:${input.day}:correction:${input.correctionTag}`;
}

/** `[windowStart, windowEnd)` UTC bounds for `YYYY-MM-DD`. */
export function utcDayBounds(day: string): { windowStart: Date; windowEnd: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new RangeError(`invalid history day ${day}: expected YYYY-MM-DD`);
  }
  const windowStart = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(windowStart.getTime()) || windowStart.toISOString().slice(0, 10) !== day) {
    throw new RangeError(`invalid history day ${day}: not a calendar date`);
  }
  const windowEnd = new Date(windowStart.getTime() + 86_400_000);
  return { windowStart, windowEnd };
}

/**
 * Deterministic gzipped NDJSON encoding: canonical JSON lines, gzip level 9, header MTIME zeroed and OS byte pinned to
 * Unix (3) so identical rows always produce byte-for-byte identical output and SHA-256 across runs and hosts.
 */
export function encodeDeterministicNdjsonGzip(rows: readonly Record<string, unknown>[]): {
  readonly payloadGzip: Buffer;
  readonly byteLength: number;
  readonly sha256: string;
} {
  const ndjson = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
  const gzipped = Buffer.from(gzipSync(Buffer.from(ndjson, 'utf8'), { level: 9 }));
  // RFC 1952 header: bytes 4..7 = MTIME (0 = none), byte 9 = OS (3 = Unix).
  gzipped[4] = 0;
  gzipped[5] = 0;
  gzipped[6] = 0;
  gzipped[7] = 0;
  gzipped[9] = 3;
  const sha256 = createHash('sha256').update(gzipped).digest('hex');
  return { payloadGzip: gzipped, byteLength: gzipped.byteLength, sha256 };
}

/**
 * Sequence completeness and gap report for a sorted or unsorted sequence list.
 * Missing contiguous ranges between `firstSequence` and `lastSequence` are reported as `{ fromSequence, toSequence }`.
 * For kinds without contiguous per-row engine sequences (candles), pass `contiguous: false` so completeness is 100.00
 * for the observed buckets without fabricating missing gaps.
 */
export function computeSequenceCompleteness(
  sequences: readonly number[],
  opts: { contiguous?: boolean } = {},
): {
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly completenessPct: string;
  readonly gaps: HistoryGap[];
} {
  if (sequences.length === 0) {
    return { firstSequence: null, lastSequence: null, completenessPct: '0.00', gaps: [] };
  }
  const unique = [...new Set(sequences)].sort((a, b) => a - b);
  const firstSequence = unique[0];
  const lastSequence = unique[unique.length - 1];
  if (firstSequence === undefined || lastSequence === undefined) {
    return { firstSequence: null, lastSequence: null, completenessPct: '0.00', gaps: [] };
  }
  if (opts.contiguous === false) {
    return { firstSequence, lastSequence, completenessPct: '100.00', gaps: [] };
  }
  const gaps: HistoryGap[] = [];
  for (let i = 1; i < unique.length; i += 1) {
    const prev = unique[i - 1];
    const curr = unique[i];
    if (prev !== undefined && curr !== undefined && curr > prev + 1) {
      gaps.push({ fromSequence: prev + 1, toSequence: curr - 1 });
    }
  }
  const expected = lastSequence - firstSequence + 1;
  // Exact scaled integer math: round(present * 10000 / expected) → two decimals.
  const scaled = (BigInt(unique.length) * 10_000n + BigInt(expected) / 2n) / BigInt(expected);
  const whole = scaled / 100n;
  const frac = (scaled % 100n).toString().padStart(2, '0');
  return { firstSequence, lastSequence, completenessPct: `${whole}.${frac}`, gaps };
}

/** Documented public schemas served by GET /api/v1/history/schemas. */
export function publishedHistorySchemas(): HistorySchemasResponse {
  return {
    provenance: HISTORY_PROVENANCE,
    schemas: [
      {
        kind: 'trades',
        schemaVersion: HISTORY_SCHEMA_VERSION,
        format: 'ndjson',
        compression: 'gzip',
        checksumAlgorithm: 'sha256',
        provenance: HISTORY_PROVENANCE,
        fields: [
          { name: 'schemaVersion', type: 'string', description: 'Schema version identifier ("1").' },
          { name: 'symbol', type: 'string', description: 'Market symbol (e.g. BTC/USDT).' },
          {
            name: 'id',
            type: 'string',
            description: 'Public tape id (the engine match sequence as a string; never an order or account id).',
          },
          { name: 'sequence', type: 'integer', description: 'Monotonic matching engine sequence number for this market.' },
          { name: 'side', type: 'string', description: 'Taker side: "buy" or "sell".' },
          { name: 'price', type: 'decimal_string', description: 'Execution price as an exact decimal string.' },
          { name: 'qty', type: 'decimal_string', description: 'Executed base quantity as an exact decimal string.' },
          { name: 'quoteAmount', type: 'decimal_string', description: 'Executed quote notional as an exact decimal string.' },
          { name: 'ts', type: 'iso8601_utc', description: 'UTC execution timestamp.' },
        ],
      },
      {
        kind: 'candles',
        schemaVersion: HISTORY_SCHEMA_VERSION,
        format: 'ndjson',
        compression: 'gzip',
        checksumAlgorithm: 'sha256',
        provenance: HISTORY_PROVENANCE,
        fields: [
          { name: 'schemaVersion', type: 'string', description: 'Schema version identifier ("1").' },
          { name: 'symbol', type: 'string', description: 'Market symbol.' },
          { name: 'timeframe', type: 'string', description: 'Candle bucket interval ("1m").' },
          { name: 'openTimeMs', type: 'integer', description: 'Bucket start time in Unix milliseconds.' },
          { name: 'openTime', type: 'iso8601_utc', description: 'Bucket start time in UTC ISO-8601.' },
          { name: 'open', type: 'decimal_string', description: 'First trade price in the bucket, ordered by engine sequence.' },
          { name: 'high', type: 'decimal_string', description: 'Highest trade price in the bucket.' },
          { name: 'low', type: 'decimal_string', description: 'Lowest trade price in the bucket.' },
          { name: 'close', type: 'decimal_string', description: 'Last trade price in the bucket, ordered by engine sequence.' },
          { name: 'volume', type: 'decimal_string', description: 'Summed base trade quantity in the bucket.' },
        ],
      },
      {
        kind: 'book_snapshots',
        schemaVersion: HISTORY_SCHEMA_VERSION,
        format: 'ndjson',
        compression: 'gzip',
        checksumAlgorithm: 'sha256',
        provenance: HISTORY_PROVENANCE,
        fields: [
          { name: 'schemaVersion', type: 'string', description: 'Schema version identifier ("1").' },
          { name: 'symbol', type: 'string', description: 'Market symbol.' },
          { name: 'sequence', type: 'integer', description: 'Matching engine book sequence at capture time.' },
          { name: 'capturedAt', type: 'iso8601_utc', description: 'UTC capture timestamp.' },
          { name: 'bids', type: 'array<[decimal_string, decimal_string]>', description: 'Bid levels [price, qty], highest price first.' },
          { name: 'asks', type: 'array<[decimal_string, decimal_string]>', description: 'Ask levels [price, qty], lowest price first.' },
        ],
      },
    ],
  };
}

/** Public trade row shape written into trades datasets (built through `publicTapePrint`). */
export interface HistoryTradeRow extends Record<string, unknown> {
  readonly schemaVersion: string;
  readonly symbol: string;
  readonly id: string;
  readonly sequence: number;
  readonly side: OrderSide;
  readonly price: string;
  readonly qty: string;
  readonly quoteAmount: string;
  readonly ts: string;
}

export interface HistoryCandleRow extends Record<string, unknown> {
  readonly schemaVersion: string;
  readonly symbol: string;
  readonly timeframe: '1m';
  readonly openTimeMs: number;
  readonly openTime: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

export interface HistoryBookSnapshotRow extends Record<string, unknown> {
  readonly schemaVersion: string;
  readonly symbol: string;
  readonly sequence: number;
  readonly capturedAt: string;
  readonly bids: ReadonlyArray<readonly [string, string]>;
  readonly asks: ReadonlyArray<readonly [string, string]>;
}

const jsonColumn = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((val) => (typeof val === 'string' ? JSON.parse(val) : val), schema);

const bookLevelsSchema = z.array(z.tuple([z.string(), z.string()]));
const pgBigint = z.union([z.string(), z.number()]).transform((v) => Number(v));

const datasetRecordSchema = z.object({
  id: z.string(),
  dataset_key: z.string(),
  market_id: z.string(),
  symbol: z.string(),
  kind: historyKindSchema,
  day: z.string(),
  window_start: z.coerce.date(),
  window_end: z.coerce.date(),
  schema_version: z.string(),
  row_count: z.coerce.number().int(),
  byte_length: z.coerce.number().int(),
  sha256: z.string(),
  first_sequence: pgBigint.nullable(),
  last_sequence: pgBigint.nullable(),
  completeness_pct: z.string(),
  gaps: jsonColumn(z.array(historyGapSchema)),
  provenance: z.string(),
  generated_at: z.coerce.date(),
});
type DatasetRecord = z.infer<typeof datasetRecordSchema>;

const correctionRecordSchema = z.object({
  id: z.string(),
  dataset_id: z.string(),
  sequence_from: pgBigint,
  sequence_to: pgBigint,
  reason: z.string(),
  superseding_dataset_id: z.string(),
  superseding_sha256: z.string(),
  created_at: z.coerce.date(),
});

const fillRecordSchema = z.object({
  id: z.string(),
  side: z.enum(['buy', 'sell']),
  price: z.string(),
  qty: z.string(),
  quote_amount: z.string(),
  sequence: pgBigint,
  ts: z.coerce.date(),
});

const candleBucketSchema = z.object({
  bucket_ms: z.string(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume: z.string(),
  first_seq: z.string(),
  last_seq: z.string(),
});

const bookSnapSchema = z.object({
  sequence: pgBigint,
  captured_at: z.coerce.date(),
  bids: jsonColumn(bookLevelsSchema),
  asks: jsonColumn(bookLevelsSchema),
});

const dayRecordSchema = z.object({ day: z.string() });

const downloadRecordSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  kind: historyKindSchema,
  day: z.string(),
  sha256: z.string(),
  byte_length: z.coerce.number().int(),
  payload_gzip: z.instanceof(Uint8Array),
});

function presentManifest(row: DatasetRecord, corrections: readonly HistoryCorrection[]): HistoryDatasetManifest {
  const latestCorrection = corrections[corrections.length - 1] ?? null;
  return {
    id: row.id,
    key: row.dataset_key,
    symbol: row.symbol,
    kind: row.kind,
    day: row.day,
    windowStart: row.window_start.toISOString(),
    windowEnd: row.window_end.toISOString(),
    schemaVersion: row.schema_version,
    format: 'ndjson',
    compression: 'gzip',
    rowCount: row.row_count,
    byteLength: row.byte_length,
    sha256: row.sha256,
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
    completenessPct: Number(row.completeness_pct).toFixed(2),
    gaps: row.gaps,
    provenance: row.provenance,
    generatedAt: row.generated_at.toISOString(),
    supersededBy: latestCorrection ? latestCorrection.supersedingDatasetId : null,
    corrections: [...corrections],
    downloadPath: `/api/v1/history/datasets/${encodeURIComponent(row.id)}/download`,
  };
}

export interface HistoryDatasetDownload {
  readonly id: string;
  readonly symbol: string;
  readonly kind: HistoryDatasetKind;
  readonly day: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly fileName: string;
  readonly payloadGzip: Buffer;
}

export function safeDownloadFileName(input: {
  readonly symbol: string;
  readonly kind: HistoryDatasetKind;
  readonly day: string;
  readonly id: string;
}): string {
  const safeSymbol = input.symbol.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'market';
  const suffix = input.id.slice(0, 8);
  return `${safeSymbol}-${input.kind}-${input.day}-${suffix}.ndjson.gz`;
}

export interface HistoryDatasetsPort {
  readonly bookIntervalMs: number | null;
  listDatasets(filter?: { symbol?: string; kind?: HistoryDatasetKind; day?: string }): Promise<HistoryDatasetManifest[]>;
  downloadDataset(id: string): Promise<HistoryDatasetDownload | null>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SQL-backed historical dataset store and builder.
 *
 * Crash safety: payload compression and checksum calculation finish in memory before a single atomic INSERT/UPSERT
 * writes both the bytes and manifest metadata together, so a crash mid-file never leaves a partial manifest row.
 */
export class SqlHistoryDatasets implements HistoryDatasetsPort {
  readonly bookIntervalMs: number | null;

  constructor(
    private readonly sql: Sql,
    opts: { bookIntervalMs?: number | null } = {},
  ) {
    this.bookIntervalMs = opts.bookIntervalMs ?? null;
  }

  /** Store one matching-engine book snapshot. Refuses if `bookIntervalMs` is unset. */
  async captureBookSnapshot(market: Pick<Market, 'id' | 'symbol'>, depth: EngineDepth, capturedAt: Date = new Date()): Promise<void> {
    if (this.bookIntervalMs === null) {
      throw new TradeError('TRADE_HISTORY_BOOK_INTERVAL_MS is blank — no book snapshot is captured', TRADE_HISTORY_BOOK_INTERVAL_UNSET);
    }
    await this.sql`
      INSERT INTO trade.history_book_snapshots (market_id, symbol, sequence, captured_at, bids, asks)
      VALUES (
        ${market.id},
        ${market.symbol},
        ${depth.sequence},
        ${capturedAt},
        ${JSON.stringify(depth.bids)}::text::jsonb,
        ${JSON.stringify(depth.asks)}::text::jsonb
      )
      ON CONFLICT (market_id, sequence, captured_at) DO NOTHING
    `;
  }

  /**
   * Build (or idempotently verify/refresh) the `trades` dataset for one market and UTC day from `trade.fills` via
   * `publicTapePrint` (excluding seeded orders, carrying no order or account ids). Returns null when the day has no
   * real trades.
   */
  async buildTradesDataset(market: Pick<Market, 'id' | 'symbol'>, day: string): Promise<HistoryDatasetManifest | null> {
    const { windowStart, windowEnd } = utcDayBounds(day);
    const fills = fillRecordSchema.array().parse(
      await this.sql`
        SELECT f.id, o.side, f.price::text AS price, f.qty::text AS qty,
               f.quote_amount::text AS quote_amount, f.sequence, f.ts
          FROM trade.fills f
          INNER JOIN trade.orders o ON o.id = f.order_id
          INNER JOIN trade.orders c ON c.id = f.counter_order_id
         WHERE f.market_id = ${market.id}
           AND f.liquidity = 'taker'
           AND o.seeded = false
           AND c.seeded = false
           AND f.ts >= ${windowStart}
           AND f.ts < ${windowEnd}
         ORDER BY f.sequence ASC
      `,
    );
    if (fills.length === 0) return null;

    const rows: HistoryTradeRow[] = fills.map((f) => {
      const pub = publicTapePrint({
        id: f.id,
        side: f.side,
        price: parseAmount(f.price),
        qty: parseAmount(f.qty),
        quoteAmount: parseAmount(f.quote_amount),
        sequence: f.sequence,
        ts: f.ts,
      });
      return {
        schemaVersion: HISTORY_SCHEMA_VERSION,
        symbol: market.symbol,
        id: pub.id,
        sequence: pub.sequence,
        side: pub.side,
        price: formatAmount(pub.price),
        qty: formatAmount(pub.qty),
        quoteAmount: formatAmount(pub.quoteAmount),
        ts: pub.ts.toISOString(),
      };
    });

    const stats = computeSequenceCompleteness(
      rows.map((r) => r.sequence),
      { contiguous: true },
    );
    return this.upsertDataset({
      key: datasetKeyFor(market.symbol, 'trades', day),
      marketId: market.id,
      symbol: market.symbol,
      kind: 'trades',
      day,
      windowStart,
      windowEnd,
      rows,
      stats,
    });
  }

  /**
   * Build the 1m `candles` dataset for one market and UTC day from real non-seeded taker fills.
   * Empty buckets are absent, never invented. Returns null when the day has no trades.
   */
  async buildCandlesDataset(market: Pick<Market, 'id' | 'symbol'>, day: string): Promise<HistoryDatasetManifest | null> {
    const { windowStart, windowEnd } = utcDayBounds(day);
    const spanMs = 60_000;
    const buckets = candleBucketSchema.array().parse(
      await this.sql`
        SELECT bucket_ms::text                                          AS bucket_ms,
               (array_agg(price ORDER BY sequence ASC))[1]::text        AS open,
               max(price)::text                                         AS high,
               min(price)::text                                         AS low,
               (array_agg(price ORDER BY sequence DESC))[1]::text       AS close,
               sum(qty)::text                                           AS volume,
               min(sequence)::text                                      AS first_seq,
               max(sequence)::text                                      AS last_seq
          FROM (
            SELECT (floor(extract(epoch from f.ts) * 1000 / ${spanMs}::bigint)::bigint * ${spanMs}::bigint) AS bucket_ms,
                   f.price, f.qty, f.sequence
              FROM trade.fills f
              INNER JOIN trade.orders o ON o.id = f.order_id
              INNER JOIN trade.orders c ON c.id = f.counter_order_id
             WHERE f.market_id = ${market.id}
               AND f.liquidity = 'taker'
               AND o.seeded = false
               AND c.seeded = false
               AND f.ts >= ${windowStart}
               AND f.ts < ${windowEnd}
          ) AS binned
         GROUP BY bucket_ms
         ORDER BY bucket_ms ASC
      `,
    );
    if (buckets.length === 0) return null;

    const rows: HistoryCandleRow[] = buckets.map((b) => {
      const openTimeMs = Number(b.bucket_ms);
      return {
        schemaVersion: HISTORY_SCHEMA_VERSION,
        symbol: market.symbol,
        timeframe: '1m',
        openTimeMs,
        openTime: new Date(openTimeMs).toISOString(),
        open: formatAmount(parseAmount(b.open)),
        high: formatAmount(parseAmount(b.high)),
        low: formatAmount(parseAmount(b.low)),
        close: formatAmount(parseAmount(b.close)),
        volume: formatAmount(parseAmount(b.volume)),
      };
    });

    const seqs = buckets.flatMap((b) => [Number(b.first_seq), Number(b.last_seq)]);
    const stats = computeSequenceCompleteness(seqs, { contiguous: false });
    return this.upsertDataset({
      key: datasetKeyFor(market.symbol, 'candles', day),
      marketId: market.id,
      symbol: market.symbol,
      kind: 'candles',
      day,
      windowStart,
      windowEnd,
      rows,
      stats,
    });
  }

  /**
   * Build the `book_snapshots` dataset for one market and UTC day. Refuses `trade.history_book_interval_unset` when
   * `TRADE_HISTORY_BOOK_INTERVAL_MS` is blank so no book dataset is ever created without an owner interval.
   */
  async buildBookSnapshotsDataset(market: Pick<Market, 'id' | 'symbol'>, day: string): Promise<HistoryDatasetManifest | null> {
    if (this.bookIntervalMs === null) {
      throw new TradeError(
        'TRADE_HISTORY_BOOK_INTERVAL_MS is blank — no book snapshot dataset is built',
        TRADE_HISTORY_BOOK_INTERVAL_UNSET,
      );
    }
    const { windowStart, windowEnd } = utcDayBounds(day);
    const snaps = bookSnapSchema.array().parse(
      await this.sql`
        SELECT sequence, captured_at, bids, asks
          FROM trade.history_book_snapshots
         WHERE market_id = ${market.id}
           AND captured_at >= ${windowStart}
           AND captured_at < ${windowEnd}
         ORDER BY captured_at ASC, sequence ASC
      `,
    );
    if (snaps.length === 0) return null;

    const rows: HistoryBookSnapshotRow[] = snaps.map((s) => ({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      symbol: market.symbol,
      sequence: s.sequence,
      capturedAt: s.captured_at.toISOString(),
      bids: s.bids,
      asks: s.asks,
    }));

    const stats = computeSequenceCompleteness(
      rows.map((r) => r.sequence),
      { contiguous: false },
    );
    return this.upsertDataset({
      key: datasetKeyFor(market.symbol, 'book_snapshots', day),
      marketId: market.id,
      symbol: market.symbol,
      kind: 'book_snapshots',
      day,
      windowStart,
      windowEnd,
      rows,
      stats,
    });
  }

  /**
   * Append-only correction: never modifies the original dataset row. Stores a new superseding dataset and links it
   * through `trade.history_corrections` so the manifest shows both the original file and every correction.
   */
  async recordCorrection(input: {
    readonly datasetId: string;
    readonly sequenceFrom: number;
    readonly sequenceTo: number;
    readonly reason: string;
    readonly correctionTag: string;
    readonly rows: readonly Record<string, unknown>[];
    readonly sequences: readonly number[];
    readonly contiguous?: boolean;
  }): Promise<{ original: HistoryDatasetManifest; superseding: HistoryDatasetManifest }> {
    const [orig] = datasetRecordSchema.array().parse(
      await this.sql`
        SELECT id, dataset_key, market_id, symbol, kind, day, window_start, window_end,
               schema_version, row_count, byte_length, sha256, first_sequence, last_sequence,
               completeness_pct::text AS completeness_pct, gaps, provenance, generated_at
          FROM trade.history_datasets
         WHERE id = ${input.datasetId}
         LIMIT 1
      `,
    );
    if (!orig) {
      throw new TradeError('Historical dataset not found', TRADE_HISTORY_DATASET_NOT_FOUND);
    }
    const stats = computeSequenceCompleteness(input.sequences, { contiguous: input.contiguous ?? orig.kind === 'trades' });
    const superseding = await this.upsertDataset({
      key: correctionDatasetKeyFor({
        symbol: orig.symbol,
        kind: orig.kind,
        day: orig.day,
        correctionTag: input.correctionTag,
      }),
      marketId: orig.market_id,
      symbol: orig.symbol,
      kind: orig.kind,
      day: orig.day,
      windowStart: orig.window_start,
      windowEnd: orig.window_end,
      rows: input.rows,
      stats,
    });
    await this.sql`
      INSERT INTO trade.history_corrections (dataset_id, sequence_from, sequence_to, reason, superseding_dataset_id)
      VALUES (${orig.id}, ${input.sequenceFrom}, ${input.sequenceTo}, ${input.reason}, ${superseding.id})
      ON CONFLICT (dataset_id, sequence_from, sequence_to, superseding_dataset_id) DO NOTHING
    `;
    const corrections = await this.correctionsFor([orig.id]);
    return { original: presentManifest(orig, corrections.get(orig.id) ?? []), superseding };
  }

  /** Find distinct UTC days that have non-seeded fills or book snapshots for a market. */
  async activeDaysForMarket(marketId: string): Promise<{ tradeDays: string[]; bookDays: string[] }> {
    const [rawTrades, rawBooks] = await Promise.all([
      this.sql`
        SELECT DISTINCT to_char(f.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
          FROM trade.fills f
          INNER JOIN trade.orders o ON o.id = f.order_id
          INNER JOIN trade.orders c ON c.id = f.counter_order_id
         WHERE f.market_id = ${marketId}
           AND f.liquidity = 'taker'
           AND o.seeded = false
           AND c.seeded = false
         ORDER BY day DESC
         LIMIT 31
      `,
      this.bookIntervalMs !== null
        ? this.sql`
            SELECT DISTINCT to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
              FROM trade.history_book_snapshots
             WHERE market_id = ${marketId}
             ORDER BY day DESC
             LIMIT 31
          `
        : Promise.resolve([]),
    ]);
    const tradeRows = dayRecordSchema.array().parse(rawTrades);
    const bookRows = dayRecordSchema.array().parse(rawBooks);
    return {
      tradeDays: tradeRows.map((r) => r.day),
      bookDays: bookRows.map((r) => r.day),
    };
  }

  async listDatasets(filter: { symbol?: string; kind?: HistoryDatasetKind; day?: string } = {}): Promise<HistoryDatasetManifest[]> {
    const rows = datasetRecordSchema.array().parse(
      await this.sql`
        SELECT id, dataset_key, market_id, symbol, kind, day, window_start, window_end,
               schema_version, row_count, byte_length, sha256, first_sequence, last_sequence,
               completeness_pct::text AS completeness_pct, gaps, provenance, generated_at
          FROM trade.history_datasets
         WHERE (${filter.symbol ?? null}::text IS NULL OR symbol = ${filter.symbol ?? null})
           AND (${filter.kind ?? null}::text IS NULL OR kind = ${filter.kind ?? null})
           AND (${filter.day ?? null}::text IS NULL OR day = ${filter.day ?? null})
         ORDER BY day DESC, symbol ASC, kind ASC, generated_at ASC
         LIMIT 200
      `,
    );
    if (rows.length === 0) return [];
    const corrections = await this.correctionsFor(rows.map((r) => r.id));
    return rows.map((row) => presentManifest(row, corrections.get(row.id) ?? []));
  }

  async downloadDataset(id: string): Promise<HistoryDatasetDownload | null> {
    if (!UUID_RE.test(id)) return null;
    const [row] = downloadRecordSchema.array().parse(
      await this.sql`
        SELECT id, symbol, kind, day, sha256, byte_length, payload_gzip
          FROM trade.history_datasets
         WHERE id = ${id}
         LIMIT 1
      `,
    );
    if (!row) return null;
    const payloadGzip = Buffer.from(row.payload_gzip);
    return {
      id: row.id,
      symbol: row.symbol,
      kind: row.kind,
      day: row.day,
      sha256: row.sha256,
      byteLength: row.byte_length,
      fileName: safeDownloadFileName({ symbol: row.symbol, kind: row.kind, day: row.day, id: row.id }),
      payloadGzip,
    };
  }

  private async correctionsFor(datasetIds: readonly string[]): Promise<Map<string, HistoryCorrection[]>> {
    const map = new Map<string, HistoryCorrection[]>();
    if (datasetIds.length === 0) return map;
    const ids = [...datasetIds];
    const rows = correctionRecordSchema.array().parse(
      await this.sql`
        SELECT c.id, c.dataset_id, c.sequence_from, c.sequence_to, c.reason,
               c.superseding_dataset_id, d.sha256 AS superseding_sha256, c.created_at
          FROM trade.history_corrections c
          INNER JOIN trade.history_datasets d ON d.id = c.superseding_dataset_id
         WHERE c.dataset_id = ANY(${ids})
         ORDER BY c.created_at ASC
      `,
    );
    for (const row of rows) {
      const list = map.get(row.dataset_id) ?? [];
      list.push({
        id: row.id,
        sequenceFrom: row.sequence_from,
        sequenceTo: row.sequence_to,
        reason: row.reason,
        supersedingDatasetId: row.superseding_dataset_id,
        supersedingSha256: row.superseding_sha256,
        createdAt: row.created_at.toISOString(),
      });
      map.set(row.dataset_id, list);
    }
    return map;
  }

  private async upsertDataset(input: {
    readonly key: string;
    readonly marketId: string;
    readonly symbol: string;
    readonly kind: HistoryDatasetKind;
    readonly day: string;
    readonly windowStart: Date;
    readonly windowEnd: Date;
    readonly rows: readonly Record<string, unknown>[];
    readonly stats: ReturnType<typeof computeSequenceCompleteness>;
  }): Promise<HistoryDatasetManifest> {
    const encoded = encodeDeterministicNdjsonGzip(input.rows);
    const [row] = datasetRecordSchema.array().parse(
      await this.sql`
        INSERT INTO trade.history_datasets (
          dataset_key, market_id, symbol, kind, day, window_start, window_end,
          schema_version, row_count, byte_length, sha256, first_sequence, last_sequence,
          completeness_pct, gaps, provenance, payload_gzip
        ) VALUES (
          ${input.key},
          ${input.marketId},
          ${input.symbol},
          ${input.kind},
          ${input.day},
          ${input.windowStart},
          ${input.windowEnd},
          ${HISTORY_SCHEMA_VERSION},
          ${input.rows.length},
          ${encoded.byteLength},
          ${encoded.sha256},
          ${input.stats.firstSequence},
          ${input.stats.lastSequence},
          ${input.stats.completenessPct}::numeric,
          ${JSON.stringify(input.stats.gaps)}::text::jsonb,
          ${HISTORY_PROVENANCE},
          ${encoded.payloadGzip}
        )
        ON CONFLICT (dataset_key) DO UPDATE SET
          row_count = EXCLUDED.row_count,
          byte_length = EXCLUDED.byte_length,
          sha256 = EXCLUDED.sha256,
          first_sequence = EXCLUDED.first_sequence,
          last_sequence = EXCLUDED.last_sequence,
          completeness_pct = EXCLUDED.completeness_pct,
          gaps = EXCLUDED.gaps,
          payload_gzip = EXCLUDED.payload_gzip,
          generated_at = CASE
            WHEN trade.history_datasets.sha256 = EXCLUDED.sha256 THEN trade.history_datasets.generated_at
            ELSE now()
          END
        -- A window still open keeps the file first published for it: a client that read the manifest then downloads
        -- the very bytes that manifest's sha256 names. The file is rebuilt once the window has closed.
        WHERE trade.history_datasets.window_end <= now()
        RETURNING id, dataset_key, market_id, symbol, kind, day, window_start, window_end,
                  schema_version, row_count, byte_length, sha256, first_sequence, last_sequence,
                  completeness_pct::text AS completeness_pct, gaps, provenance, generated_at
      `,
    );
    // No row: the window is still open and its published file stays as it is.
    const [kept] = row
      ? [row]
      : datasetRecordSchema.array().parse(
          await this.sql`
            SELECT id, dataset_key, market_id, symbol, kind, day, window_start, window_end,
                   schema_version, row_count, byte_length, sha256, first_sequence, last_sequence,
                   completeness_pct::text AS completeness_pct, gaps, provenance, generated_at
              FROM trade.history_datasets
             WHERE dataset_key = ${input.key}
             LIMIT 1
          `,
        );
    if (!kept) {
      throw new TradeError('Historical dataset upsert returned no row', TRADE_HISTORY_DATASET_NOT_FOUND);
    }
    const corrections = await this.correctionsFor([kept.id]);
    return presentManifest(kept, corrections.get(kept.id) ?? []);
  }
}
