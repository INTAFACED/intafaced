import { describe, expect, it } from 'vitest';
import { InMemoryBalanceWatchStore } from './balance-watch-store.js';
import { VenueBalanceWatch } from './balance-watch.js';
import { AccountPace } from './account-pace.js';
import { HttpUserVenue } from './http-user-venue.js';
import { VenueReadCallers, readCaller, type VenueReadsMinute } from './venue-read-callers.js';

// Each venue read svc-trade sends is counted by the line of svc-trade code that asked, a minute at a time, so a
// reader the venue's own counter cannot name shows by name. Every figure is TEST.

/** A TEST venue over HTTP that answers every read with an empty list: an account holding nothing. */
const emptyVenue: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  const body =
    (init?.method ?? 'GET') === 'GET' && path === '/venue'
      ? { venue: { id: 'test-venue', displayName: 'TEST venue', proofLevel: 'simulator' }, chainId: 84532 }
      : { venueId: 'test-venue', value: [], asOf: '2026-11-27T21:00:00.000Z', reportedAt: null };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

describe('the venue reads by who asked', () => {
  it('names the balance watch’s own line for each balance read it makes through the HTTP venue, and the pace’s count', async () => {
    let now = Date.UTC(2026, 10, 27, 21, 0, 0);
    const minutes: VenueReadsMinute[] = [];
    const callers = new VenueReadCallers(
      () => new Date(now),
      (m) => minutes.push(m),
    );
    const venue = await HttpUserVenue.connect({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 1_000,
      fetch: emptyVenue,
      onRead: callers.onRead,
    });
    const owners = Array.from({ length: 8 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`);
    const watch = new VenueBalanceWatch({
      venue: async () => venue,
      accounts: async () => owners.map((owner, i) => ({ userId: `user-${i}`, owner, subAccount: null })),
      store: new InMemoryBalanceWatchStore(),
      publish: async () => {},
      now: () => new Date(now),
      pace: new AccountPace(24, () => new Date(now)),
    });
    // The beta's watch: every 15 s, 24 accounts a minute. Two minutes to settle, then the third is the one read.
    for (let t = 0; t < 4 * 4; t++) {
      await watch.tick();
      now += 15_000;
    }
    const third = minutes.find((m) => m.minute === '2026-11-27T21:02:00.000Z');
    expect(third).toBeDefined();
    // Two lines of the watch asked, each named by its file and line: its balance reads, at the pace, and its markets read.
    const callers3 = Object.entries(third!.byCaller);
    expect(callers3.map(([caller]) => caller)).toEqual([
      expect.stringMatching(/^venue\/balance-watch\.ts:\d+$/),
      expect.stringMatching(/^venue\/balance-watch\.ts:\d+$/),
    ]);
    expect(callers3.map(([, reads]) => reads)).toEqual([{ '/balances': 24 }, { '/markets': 4 }]);
    expect(third!.reads).toBe(28);
  });

  it('skips the venue client’s own frames and reads a built file’s line the same way', () => {
    const stack = [
      'Error',
      '    at VenueReadCallers.count (file:///box/services/svc-trade/dist/venue/venue-read-callers.js:44:20)',
      '    at VenueReadCallers.onRead (file:///box/services/svc-trade/dist/venue/venue-read-callers.js:40:51)',
      '    at HttpUserVenue.read (file:///box/services/svc-trade/dist/venue/http-user-venue.js:204:19)',
      '    at Object.balances (file:///box/packages/venue-contracts/dist/user-venue-calls.js:30:41)',
      '    at RecurringBuys.free (file:///box/services/svc-trade/dist/recurring/recurring-buys.js:233:37)',
    ].join('\n');
    expect(readCaller(stack)).toBe('recurring/recurring-buys.js:233');
    expect(readCaller('Error\n    at node:internal/process/task_queues:105:5')).toBe('unknown');
    expect(readCaller(undefined)).toBe('unknown');
  });
});
