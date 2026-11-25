import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HISTORY_PROVENANCE,
  TRADE_HISTORY_BOOK_INTERVAL_UNSET,
  TRADE_HISTORY_DATASET_NOT_FOUND,
  type HistoryDatasetManifest,
} from '@intafaced/contracts/trade-history';
import { installRouteInventory } from '../route-inventory.js';
import { encodeDeterministicNdjsonGzip, type HistoryDatasetDownload, type HistoryDatasetsPort } from './history-datasets.js';
import { registerHistoryRestRoutes } from './history-rest.js';

const SECRET = 'a-history-rest-test-edge-secret-long-enough';
const DATASET_ID = '11111111-1111-4111-8111-111111111111';
const SUPERSEDING_ID = '22222222-2222-4222-8222-222222222222';

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

async function mount(history: HistoryDatasetsPort | undefined) {
  app = Fastify();
  installRouteInventory(app, { edgeSecret: SECRET, serviceName: 'svc-trade' });
  registerHistoryRestRoutes(app, history);
  await app.ready();
  return app;
}

describe('historical market data REST routes (RC-cex-spot-05; J-cex-spot-15 #10)', () => {
  it('serves documented schemas at GET /api/v1/history/schemas', async () => {
    await mount(undefined);
    const res = await app.inject({ method: 'GET', url: '/api/v1/history/schemas' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provenance).toBe(HISTORY_PROVENANCE);
    expect(body.schemas.map((s: { kind: string }) => s.kind)).toEqual(['trades', 'candles', 'book_snapshots']);
  });

  it('refuses kind=book_snapshots with trade.history_book_interval_unset when interval is blank', async () => {
    await mount({
      bookIntervalMs: null,
      listDatasets: async () => [],
      downloadDataset: async () => null,
    });
    const refused = await app.inject({ method: 'GET', url: '/api/v1/history/datasets?kind=book_snapshots' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      code: 'NotSupported',
      intafacedCode: TRADE_HISTORY_BOOK_INTERVAL_UNSET,
    });

    const unfiltered = await app.inject({ method: 'GET', url: '/api/v1/history/datasets' });
    expect(unfiltered.statusCode).toBe(200);
    expect(unfiltered.json()).toMatchObject({
      datasets: [],
      bookIntervalMs: null,
      bookSnapshotsStatus: 'unset',
      bookSnapshotsCode: TRADE_HISTORY_BOOK_INTERVAL_UNSET,
    });
  });

  it('lists manifests with completeness, gaps and corrections, and downloads matching gzip bytes with sha256', async () => {
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
    ];
    const encoded = encodeDeterministicNdjsonGzip(rows);
    const manifest: HistoryDatasetManifest = {
      id: DATASET_ID,
      key: 'history:BTC/USDT:trades:2026-11-24',
      symbol: 'BTC/USDT',
      kind: 'trades',
      day: '2026-11-24',
      windowStart: '2026-11-24T00:00:00.000Z',
      windowEnd: '2026-11-25T00:00:00.000Z',
      schemaVersion: '1',
      format: 'ndjson',
      compression: 'gzip',
      rowCount: 1,
      byteLength: encoded.byteLength,
      sha256: encoded.sha256,
      firstSequence: 1,
      lastSequence: 1,
      completenessPct: '100.00',
      gaps: [],
      provenance: HISTORY_PROVENANCE,
      generatedAt: '2026-11-24T00:05:00.000Z',
      supersededBy: SUPERSEDING_ID,
      corrections: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          sequenceFrom: 1,
          sequenceTo: 1,
          reason: 'TEST backfill',
          supersedingDatasetId: SUPERSEDING_ID,
          supersedingSha256: encoded.sha256,
          createdAt: '2026-11-24T00:10:00.000Z',
        },
      ],
      downloadPath: `/api/v1/history/datasets/${DATASET_ID}/download`,
    };
    const file: HistoryDatasetDownload = {
      id: DATASET_ID,
      symbol: 'BTC/USDT',
      kind: 'trades',
      day: '2026-11-24',
      sha256: encoded.sha256,
      byteLength: encoded.byteLength,
      fileName: 'BTC-USDT-trades-2026-11-24-11111111.ndjson.gz',
      payloadGzip: encoded.payloadGzip,
    };

    await mount({
      bookIntervalMs: 5000,
      listDatasets: async () => [manifest],
      downloadDataset: async (id) => (id === DATASET_ID ? file : null),
    });

    const list = await app.inject({ method: 'GET', url: '/api/v1/history/datasets?symbol=BTC/USDT&kind=trades&day=2026-11-24' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      bookIntervalMs: 5000,
      bookSnapshotsStatus: 'configured',
      bookSnapshotsCode: null,
      datasets: [manifest],
    });

    const dl = await app.inject({ method: 'GET', url: `/api/v1/history/datasets/${DATASET_ID}/download` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/gzip');
    expect(dl.headers['x-content-sha256']).toBe(encoded.sha256);
    expect(dl.headers['content-disposition']).toContain('BTC-USDT-trades-2026-11-24-11111111.ndjson.gz');
    expect(createHash('sha256').update(dl.rawPayload).digest('hex')).toBe(encoded.sha256);
    const parsed = JSON.parse(gunzipSync(dl.rawPayload).toString('utf8').trim());
    expect(parsed).toEqual(rows[0]);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/history/datasets/99999999-9999-4999-8999-999999999999/download' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      code: 'OrderNotFound',
      message: 'Historical dataset not found',
      intafacedCode: TRADE_HISTORY_DATASET_NOT_FOUND,
    });
  });

  it('refuses invalid kind or day query parameters with 400', async () => {
    await mount(undefined);
    const badKind = await app.inject({ method: 'GET', url: '/api/v1/history/datasets?kind=bogus' });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json().intafacedCode).toBe('trade.validation_failed');
    const badDay = await app.inject({ method: 'GET', url: '/api/v1/history/datasets?day=yesterday' });
    expect(badDay.statusCode).toBe(400);
    expect(badDay.json().intafacedCode).toBe('trade.validation_failed');
  });
});
