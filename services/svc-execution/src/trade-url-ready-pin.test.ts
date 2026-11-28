import { describe, expect, it } from 'vitest';
import { bootExecution } from './testing/boot.js';
import { EXECUTION_TRADE_BOOK_UNPROBED } from './ready-response.js';
import { TRADE_BOOK_SNAPSHOT_VENUE_ID } from './trade-book-snapshot.js';

/** The booted host's /ready, and the venues its router can snapshot a book from (parameter 13). */
async function bootedReady(vars: Record<string, string>) {
  const booted = await bootExecution(vars);
  try {
    const ready = await booted.app.inject({ method: 'GET', url: '/ready' });
    return { ready: ready.json(), snapshotVenues: Object.keys(booted.routerArgs[12] as object) };
  } finally {
    await booted.close();
  }
}

describe('execution ready trade snapshot pin', () => {
  it('/ready reports tradeBookSnapshotVenue as configured + unprobed when TRADE_URL set', async () => {
    const set = await bootedReady({ TRADE_URL: 'http://trade.test:4004' });
    expect(set.ready.tradeBookSnapshotVenue).toEqual({
      status: 'configured',
      venueId: TRADE_BOOK_SNAPSHOT_VENUE_ID,
      probe: 'unprobed',
      code: EXECUTION_TRADE_BOOK_UNPROBED,
    });
    expect(set.snapshotVenues).toContain(TRADE_BOOK_SNAPSHOT_VENUE_ID);

    const unset = await bootedReady({});
    expect(unset.ready.tradeBookSnapshotVenue).toMatchObject({ status: 'absent', venueId: null, probe: 'unprobed' });
    expect(unset.snapshotVenues).not.toContain(TRADE_BOOK_SNAPSHOT_VENUE_ID);
  });
});
