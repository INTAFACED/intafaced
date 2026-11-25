import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client/money';
import {
  loadOrderRecording,
  RECORDED_ORDER_NOW_MS,
  replayRecording,
  runRecordedOrder,
  startHyperliquidVenueServer,
} from '@intafaced/venue-hyperliquid';
import { HttpUserVenue } from './http-user-venue.js';

/**
 * svc-trade reaches the Hyperliquid test network as a running venue, over the same HTTP venue protocol as every
 * venue (http-user-venue.ts), with the venue's answers played back from a recording (`hl-recorded`), so CI needs no
 * network. A TEST order placed through svc-trade's client reaches the venue, is accepted, and its fill reads back.
 */

let server: http.Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function connect() {
  const started = await startHyperliquidVenueServer({
    host: '127.0.0.1',
    port: 0,
    appEnv: 'test',
    fetch: replayRecording(loadOrderRecording()),
    clock: () => new Date(RECORDED_ORDER_NOW_MS),
  });
  server = started.server;
  return HttpUserVenue.connect({ baseUrl: started.url, timeoutMs: 5_000 });
}

describe('the Hyperliquid test network behind the HTTP venue protocol (hl-recorded)', () => {
  it('connects as a TEST partner-sandbox venue on the wallet chain the venue signs user actions on', async () => {
    const venue = await connect();
    expect(venue.venue).toMatchObject({ id: 'hyperliquid-testnet', proofLevel: 'partner-sandbox' });
    expect(venue.venue.displayName).toMatch(/^TEST /);
    expect(venue.chainId).toBe(421_614);
    expect(venue.depositRoute).toBeNull();
  });

  it('a TEST order reaches the venue, is accepted, reads back filled, and its fill is listed', async () => {
    const venue = await connect();
    const run = await runRecordedOrder(venue);
    expect(run.markets.value.some((m) => m.symbol === 'BTC-PERP')).toBe(true);
    expect(run.outcome.definite && run.outcome.accepted).toBe(true);
    expect(run.order.value?.status).toBe('filled');
    expect(run.fills.value.map((f) => [f.symbol, f.side, formatAmount(f.amount), f.venueClientOrderId])).toEqual([
      ['BTC-PERP', 'buy', '0.001', run.prepared.venueClientOrderId],
    ]);
  });

  it('a read the venue cannot answer is venue_down, never a figure', async () => {
    const started = await startHyperliquidVenueServer({
      host: '127.0.0.1',
      port: 0,
      appEnv: 'test',
      fetch: replayRecording({ label: 'TEST', note: '', calls: [] }),
    });
    server = started.server;
    const venue = await HttpUserVenue.connect({ baseUrl: started.url, timeoutMs: 5_000 });
    await expect(venue.markets(null)).rejects.toMatchObject({ refusal: { code: 'venue_down' } });
  });
});
