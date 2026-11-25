import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  computeSequenceCompleteness,
  correctionDatasetKeyFor,
  datasetKeyFor,
  encodeDeterministicNdjsonGzip,
  publishedHistorySchemas,
  safeDownloadFileName,
  utcDayBounds,
} from './history-datasets.js';

describe('historical market data datasets (RC-cex-spot-05)', () => {
  it('computes completeness 98.00% and gap 51..52 when sequences 1..100 have 98 rows', () => {
    const sequences: number[] = [];
    for (let s = 1; s <= 100; s += 1) {
      if (s === 51 || s === 52) continue;
      sequences.push(s);
    }
    const stats = computeSequenceCompleteness(sequences, { contiguous: true });
    expect(stats.firstSequence).toBe(1);
    expect(stats.lastSequence).toBe(100);
    expect(stats.completenessPct).toBe('98.00');
    expect(stats.gaps).toEqual([{ fromSequence: 51, toSequence: 52 }]);
  });

  it('computes 100.00% with no gaps for contiguous sequences and non-contiguous checkpoint kinds', () => {
    expect(computeSequenceCompleteness([10, 11, 12], { contiguous: true })).toEqual({
      firstSequence: 10,
      lastSequence: 12,
      completenessPct: '100.00',
      gaps: [],
    });
    expect(computeSequenceCompleteness([10, 42, 99], { contiguous: false })).toEqual({
      firstSequence: 10,
      lastSequence: 99,
      completenessPct: '100.00',
      gaps: [],
    });
  });

  it('encodes deterministic gzipped NDJSON with identical bytes and SHA-256 on rerun', () => {
    const rows = [
      {
        schemaVersion: '1',
        symbol: 'BTC/USDT',
        id: '1',
        sequence: 1,
        side: 'buy',
        price: '65000',
        qty: '0.01',
        quoteAmount: '650',
        ts: '2026-11-24T00:00:01.000Z',
      },
      {
        schemaVersion: '1',
        symbol: 'BTC/USDT',
        id: '2',
        sequence: 2,
        side: 'sell',
        price: '65010',
        qty: '0.02',
        quoteAmount: '1300.2',
        ts: '2026-11-24T00:00:02.000Z',
      },
    ];
    const first = encodeDeterministicNdjsonGzip(rows);
    const second = encodeDeterministicNdjsonGzip(rows);
    expect(first.payloadGzip.equals(second.payloadGzip)).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(createHash('sha256').update(first.payloadGzip).digest('hex')).toBe(first.sha256);
    const lines = gunzipSync(first.payloadGzip)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual(rows);
  });

  it('builds stable business keys and safe download filenames', () => {
    expect(datasetKeyFor('BTC/USDT', 'trades', '2026-11-24')).toBe('history:BTC/USDT:trades:2026-11-24');
    expect(correctionDatasetKeyFor({ symbol: 'BTC/USDT', kind: 'trades', day: '2026-11-24', correctionTag: 'seq10' })).toBe(
      'history:BTC/USDT:trades:2026-11-24:correction:seq10',
    );
    expect(
      safeDownloadFileName({
        symbol: 'BTC/USDT',
        kind: 'trades',
        day: '2026-11-24',
        id: '11111111-2222-3333-4444-555555555555',
      }),
    ).toBe('BTC-USDT-trades-2026-11-24-11111111.ndjson.gz');
  });

  it('validates UTC day bounds and publishes schemas for trades, candles and book_snapshots', () => {
    const bounds = utcDayBounds('2026-11-24');
    expect(bounds.windowStart.toISOString()).toBe('2026-11-24T00:00:00.000Z');
    expect(bounds.windowEnd.toISOString()).toBe('2026-11-25T00:00:00.000Z');
    expect(() => utcDayBounds('2026-02-30')).toThrow(/not a calendar date/);

    const schemas = publishedHistorySchemas();
    expect(schemas.provenance).toBe("this venue's own matching sequence");
    expect(schemas.schemas.map((s) => s.kind)).toEqual(['trades', 'candles', 'book_snapshots']);
    for (const entry of schemas.schemas) {
      expect(entry.format).toBe('ndjson');
      expect(entry.compression).toBe('gzip');
      expect(entry.checksumAlgorithm).toBe('sha256');
      expect(entry.fields.some((f) => /user|account|orderId/i.test(f.name))).toBe(false);
    }
  });
});
