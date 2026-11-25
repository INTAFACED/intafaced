// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_PROVENANCE, TRADE_HISTORY_BOOK_INTERVAL_UNSET } from '@intafaced/contracts/trade-history';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const world = vi.hoisted(() => ({
  answers: {} as Record<string, unknown>,
}));

vi.mock('../../session', () => ({
  useSession: () => ({
    userId: null,
    api: {
      rest: vi.fn(async (path: string) => {
        const value = world.answers[path];
        if (value && typeof value === 'object' && 'ok' in (value as Record<string, unknown>)) return value;
        return { ok: true, data: value };
      }),
    },
  }),
}));

import { DataDownloadsRoom } from './DataDownloadsRoom';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  world.answers = {};
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mountAndFlush() {
  await act(async () => {
    root.render(<DataDownloadsRoom />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('DataDownloadsRoom (RC-cex-spot-05; J-cex-spot-15 #10)', () => {
  it('renders datasets with published window, completeness, gaps, SHA-256 checksum, corrections and download link', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const supId = '22222222-2222-4222-8222-222222222222';
    const sha = 'a'.repeat(64);
    world.answers = {
      '/history/datasets': {
        datasets: [
          {
            id,
            key: 'history:BTC/USDT:trades:2026-11-24',
            symbol: 'BTC/USDT',
            kind: 'trades',
            day: '2026-11-24',
            windowStart: '2026-11-24T00:00:00.000Z',
            windowEnd: '2026-11-25T00:00:00.000Z',
            schemaVersion: '1',
            format: 'ndjson',
            compression: 'gzip',
            rowCount: 98,
            byteLength: 2048,
            sha256: sha,
            firstSequence: 1,
            lastSequence: 100,
            completenessPct: '98.00',
            gaps: [{ fromSequence: 51, toSequence: 52 }],
            provenance: HISTORY_PROVENANCE,
            generatedAt: '2026-11-24T00:05:00.000Z',
            supersededBy: supId,
            corrections: [
              {
                id: '33333333-3333-4333-8333-333333333333',
                sequenceFrom: 51,
                sequenceTo: 52,
                reason: 'TEST backfill',
                supersedingDatasetId: supId,
                supersedingSha256: 'b'.repeat(64),
                createdAt: '2026-11-24T00:10:00.000Z',
              },
            ],
            downloadPath: `/api/v1/history/datasets/${id}/download`,
          },
        ],
        bookIntervalMs: 5000,
        bookSnapshotsStatus: 'configured',
        bookSnapshotsCode: null,
      },
      '/history/schemas': {
        provenance: HISTORY_PROVENANCE,
        schemas: [
          {
            kind: 'trades',
            schemaVersion: '1',
            format: 'ndjson',
            compression: 'gzip',
            checksumAlgorithm: 'sha256',
            provenance: HISTORY_PROVENANCE,
            fields: [],
          },
        ],
      },
    };
    await mountAndFlush();
    const table = host.querySelector('[data-testid="history-datasets-table"]');
    expect(table).not.toBeNull();
    expect(host.textContent).toContain('BTC/USDT');
    expect(host.textContent).toContain('98.00%');
    expect(host.textContent).toContain('Gaps: 51..52');
    expect(host.querySelector(`[data-testid="checksum-${id}"]`)?.textContent).toBe(sha);
    expect(host.querySelector(`[data-testid="download-${id}"]`)?.getAttribute('href')).toBe(`/api/v1/history/datasets/${id}/download`);
    expect(host.textContent).toContain('TEST backfill');
  });

  it('shows the honest book-unset notice when book snapshots interval is blank', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    world.answers = {
      '/history/datasets': {
        datasets: [
          {
            id,
            key: 'history:BTC/USDT:trades:2026-11-24',
            symbol: 'BTC/USDT',
            kind: 'trades',
            day: '2026-11-24',
            windowStart: '2026-11-24T00:00:00.000Z',
            windowEnd: '2026-11-25T00:00:00.000Z',
            schemaVersion: '1',
            format: 'ndjson',
            compression: 'gzip',
            rowCount: 10,
            byteLength: 512,
            sha256: 'c'.repeat(64),
            firstSequence: 1,
            lastSequence: 10,
            completenessPct: '100.00',
            gaps: [],
            provenance: HISTORY_PROVENANCE,
            generatedAt: '2026-11-24T00:05:00.000Z',
            supersededBy: null,
            corrections: [],
            downloadPath: `/api/v1/history/datasets/${id}/download`,
          },
        ],
        bookIntervalMs: null,
        bookSnapshotsStatus: 'unset',
        bookSnapshotsCode: TRADE_HISTORY_BOOK_INTERVAL_UNSET,
      },
      '/history/schemas': { provenance: HISTORY_PROVENANCE, schemas: [] },
    };
    await mountAndFlush();
    const note = host.querySelector('[data-testid="history-book-unset"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain(TRADE_HISTORY_BOOK_INTERVAL_UNSET);
  });

  it('shows the empty state when no datasets are published yet', async () => {
    world.answers = {
      '/history/datasets': {
        datasets: [],
        bookIntervalMs: 5000,
        bookSnapshotsStatus: 'configured',
        bookSnapshotsCode: null,
      },
      '/history/schemas': { provenance: HISTORY_PROVENANCE, schemas: [] },
    };
    await mountAndFlush();
    expect(host.textContent).toContain('No historical datasets published');
  });

  it('shows the refused state when the service refuses with trade.history_book_interval_unset', async () => {
    world.answers = {
      '/history/datasets': {
        ok: false,
        reason: 'not-allowed',
        status: 400,
        code: TRADE_HISTORY_BOOK_INTERVAL_UNSET,
        message: 'Interval unset',
      },
      '/history/schemas': { provenance: HISTORY_PROVENANCE, schemas: [] },
    };
    await mountAndFlush();
    expect(host.textContent).toContain('Book snapshots are not configured');
  });
});
