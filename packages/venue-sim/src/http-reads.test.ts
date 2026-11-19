import { describe, expect, it } from 'vitest';
import { USER_VENUE_READS } from '@intafaced/venue-contracts';
import { TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_MARKETS, answerTestVenue } from './http-server.js';

// svc-trade's HTTP client builds one method per USER_VENUE_READS entry (venue-contracts user-venue-calls.ts), so every
// path there must be a route here: a read added to the table and not to http-server.ts's route() answers 404.

describe('the TEST venue server routes every read the HTTP client sends', () => {
  const sim = new TestVenueSimulator({ clock: () => new Date(Date.UTC(2026, 10, 18, 3)), markets: TEST_VENUE_MARKETS });

  for (const [name, { path }] of Object.entries(USER_VENUE_READS)) {
    it(`${name} (${path}) has a route`, async () => {
      // An empty body: a known route refuses its missing arguments (400) or answers; only an unknown path is 404.
      const [status, out] = await answerTestVenue(sim, 'POST', path, '{}');
      expect(status, JSON.stringify(out)).not.toBe(404);
    });
  }
});
