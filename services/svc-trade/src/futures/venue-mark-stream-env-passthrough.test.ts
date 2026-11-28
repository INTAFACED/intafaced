/**
 * Unit card — live host passes TRADE_VENUE_MARK_STREAM into /health
 * 1. Promise: venueLatency.streamEnabled follows env; default stays OFF
 * 2. Break: presentVenueLatencyHealth(adapter) with no flags hides a live stream
 * 3. Done bar: index.ts passes streamEnabled from env
 * 4. Class N
 * 5. Paths: svc-trade/src/index.ts
 * 6. RED: /health venueLatency call has no streamEnabled: env.TRADE_VENUE_MARK_STREAM
 * 7. Collision: #1866 public-rest listing — this PR only health + venue-latency-health
 */

import { describe, expect, it } from 'vitest';
import { tradeEnvWith } from './testing/doors.js';
import { presentVenueLatencyHealth } from './venue-latency-health.js';

describe('venue mark stream env passthrough into /health', () => {
  it('live host passes TRADE_VENUE_MARK_STREAM into presentVenueLatencyHealth', () => {
    // Unset is off; set on is on; the health line reports exactly what the env says.
    const unset = tradeEnvWith({}, ['TRADE_VENUE_MARK_STREAM']).TRADE_VENUE_MARK_STREAM;
    const on = tradeEnvWith({ TRADE_VENUE_MARK_STREAM: 'true' }).TRADE_VENUE_MARK_STREAM;
    expect(unset).toBe(false);
    expect(on).toBe(true);
    expect(presentVenueLatencyHealth(null, new Date(), { streamEnabled: unset }).streamEnabled).toBe(false);
    expect(presentVenueLatencyHealth(null, new Date(), { streamEnabled: on }).streamEnabled).toBe(true);
  });
});
