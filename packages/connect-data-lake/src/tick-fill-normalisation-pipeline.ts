/**
 * Tick/fill normalisation pipeline — fabric wire → connect.data-lake CaptureLog (§27:762).
 *
 * Decimal strings on the wire via ledger-client formatting. Unconnected venues
 * stay absent — never synthetic quiet ticks or fills.
 */
import { formatAmount } from '@intafaced/ledger-client';
import { CaptureLog, type CaptureRecord, type FillObservation, type TickObservation, type VenueConnection } from './capture.js';
import { absentReasonFromCaptureLakeHole, type CaptureLakeHoleRecord } from './capture-lake-consumer.js';

export interface CaptureLakeTickWireRecord {
  readonly kind: 'tick';
  readonly venueId: string;
  readonly symbol: string;
  readonly capturedAt: Date;
  readonly price: bigint;
  readonly quantity: bigint;
  readonly ts: string;
}

export interface CaptureLakeFillWireRecord {
  readonly kind: 'fill';
  readonly venueId: string;
  readonly symbol: string;
  readonly capturedAt: Date;
  readonly price: bigint;
  readonly quantity: bigint;
  readonly ts: string;
  readonly sequence: number;
}

export type CaptureLakeTickFillWireRecord = CaptureLakeTickWireRecord | CaptureLakeFillWireRecord | CaptureLakeHoleRecord;

export interface IngestTickFillOptions {
  readonly marketId?: string;
  readonly connection?: VenueConnection;
  /** Absent hole rows default to `tick` when the fabric hole is kind-agnostic. */
  readonly absentKind?: 'tick' | 'fill';
}

export function describeTickFillNormalisationPipeline() {
  return {
    normalisesFabricTicks: true as const,
    normalisesFabricFills: true as const,
    refusesUnconnected: true as const,
    usesLedgerAmountFormatting: true as const,
    neverInventsQuietMarket: true as const,
  };
}

function marketIdFor(record: CaptureLakeTickFillWireRecord, options: IngestTickFillOptions): string {
  return options.marketId ?? record.symbol;
}

function connectionFor(record: CaptureLakeTickFillWireRecord, options: IngestTickFillOptions): VenueConnection {
  if (record.kind === 'hole') {
    return record.reason === 'not_connected' ? 'not_connected' : 'unknown';
  }
  return options.connection ?? 'connected';
}

export function tickObservationFromWireRecord(record: CaptureLakeTickWireRecord, options: IngestTickFillOptions = {}): TickObservation {
  const connection = connectionFor(record, options);
  if (connection !== 'connected') {
    return { venueId: record.venueId, marketId: marketIdFor(record, options), connection, tick: null };
  }
  return {
    venueId: record.venueId,
    marketId: marketIdFor(record, options),
    connection: 'connected',
    tick: {
      price: formatAmount(record.price),
      quantity: formatAmount(record.quantity),
      ts: record.ts,
    },
  };
}

export function fillObservationFromWireRecord(record: CaptureLakeFillWireRecord, options: IngestTickFillOptions = {}): FillObservation {
  const connection = connectionFor(record, options);
  if (connection !== 'connected') {
    return { venueId: record.venueId, marketId: marketIdFor(record, options), connection, fill: null };
  }
  return {
    venueId: record.venueId,
    marketId: marketIdFor(record, options),
    connection: 'connected',
    fill: {
      price: formatAmount(record.price),
      quantity: formatAmount(record.quantity),
      ts: record.ts,
      sequence: record.sequence,
    },
  };
}

export function captureRecordFromTickFillWire(record: CaptureLakeTickFillWireRecord, options: IngestTickFillOptions = {}): CaptureRecord {
  const capturedAt = record.capturedAt.toISOString();

  if (record.kind === 'hole') {
    const kind = options.absentKind ?? 'tick';
    return {
      status: 'absent',
      reason: absentReasonFromCaptureLakeHole(record.reason),
      kind,
      venueId: record.venueId,
      marketId: marketIdFor(record, options),
      capturedAt,
    };
  }

  if (record.kind === 'tick') {
    const observation = tickObservationFromWireRecord(record, options);
    const tick = observation.tick ?? null;
    if (observation.connection !== 'connected' || tick === null) {
      return {
        status: 'absent',
        reason: observation.connection === 'not_connected' ? 'venue_not_connected' : 'observation_missing',
        kind: 'tick',
        venueId: observation.venueId,
        marketId: observation.marketId,
        capturedAt,
      };
    }
    return {
      status: 'measured',
      kind: 'tick',
      venueId: observation.venueId,
      marketId: observation.marketId,
      capturedAt,
      price: tick.price,
      quantity: tick.quantity,
      ts: tick.ts,
    };
  }

  const observation = fillObservationFromWireRecord(record, options);
  const fill = observation.fill ?? null;
  if (observation.connection !== 'connected' || fill === null) {
    return {
      status: 'absent',
      reason: observation.connection === 'not_connected' ? 'venue_not_connected' : 'observation_missing',
      kind: 'fill',
      venueId: observation.venueId,
      marketId: observation.marketId,
      capturedAt,
    };
  }
  return {
    status: 'measured',
    kind: 'fill',
    venueId: observation.venueId,
    marketId: observation.marketId,
    capturedAt,
    price: fill.price,
    quantity: fill.quantity,
    ts: fill.ts,
    sequence: fill.sequence,
  };
}

export function ingestTickFillWireRecord(
  log: CaptureLog,
  record: CaptureLakeTickFillWireRecord,
  options: IngestTickFillOptions = {},
): CaptureRecord {
  if (record.kind === 'tick') {
    return log.captureTick(tickObservationFromWireRecord(record, options));
  }
  if (record.kind === 'fill') {
    return log.captureFill(fillObservationFromWireRecord(record, options));
  }
  if (record.kind === 'hole') {
    const observation = {
      venueId: record.venueId,
      marketId: marketIdFor(record, options),
      connection: record.reason === 'not_connected' ? ('not_connected' as const) : ('unknown' as const),
      tick: null,
      fill: null,
    };
    const kind = options.absentKind ?? 'tick';
    return kind === 'fill' ? log.captureFill({ ...observation, fill: null }) : log.captureTick({ ...observation, tick: null });
  }
  return captureRecordFromTickFillWire(record, options);
}

export function ingestTickFillWireRecords(
  log: CaptureLog,
  records: readonly CaptureLakeTickFillWireRecord[],
  options: IngestTickFillOptions = {},
): CaptureRecord[] {
  return records.map((record) => ingestTickFillWireRecord(log, record, options));
}
