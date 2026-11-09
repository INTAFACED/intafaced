import { describe, expect, it } from 'vitest';
import {
  venueDelistingPayloadHash,
  venueLimitsPayloadHash,
  venueLimitsTarget,
  venueListingPayloadHash,
  venueListingTarget,
  venueRoutingPayloadHash,
} from './venue-markets-hash';

// services/svc-trade/src/admin/venue-markets.test.ts pins the same four values.
const b = { venueId: 'test-venue-sim', symbol: 'ETH-USDC', expectedVersion: '1', reason: 'TEST reason' };

describe('venue markets approval hashes (J-cex-spot-16)', () => {
  it('are the hashes svc-trade checks', () => {
    expect(venueListingPayloadHash({ ...b, opensAt: '2026-11-09T20:00:00+08:00' })).toBe(
      'sha256:e8d529fa1d849cf5f91827ce42dad8148253637ab42f6a8746804f13dbb82bb8',
    );
    expect(venueRoutingPayloadHash({ ...b, routing: 'stop' })).toBe(
      'sha256:cdd1279a90ea828669d27d13cb9b15f949e03e5799d900f914b0697d97e2986c',
    );
    expect(venueLimitsPayloadHash({ ...b, maxOrderQty: '5.50', maxOrderNotional: '15000' })).toBe(
      'sha256:435bd21d255c0c1612cc271ef29494226ef5477269261b2dd9f8cd979ab91923',
    );
    expect(venueDelistingPayloadHash({ ...b, delistsAt: '2026-12-01T00:00:00Z' })).toBe(
      'sha256:d592d613ecbdfaead7241fdb46479484f36bf6400debd4cc6c09c156916d23f1',
    );
    expect(venueListingTarget('test-venue-sim', 'ETH-USDC')).toBe('venue-listing:test-venue-sim:ETH-USDC');
    expect(venueLimitsTarget('test-venue-sim', 'ETH-USDC')).toBe('venue-limits:test-venue-sim:ETH-USDC');
  });

  it('changes with the version and with the reason', () => {
    const one = venueRoutingPayloadHash({ ...b, routing: 'stop' });
    expect(venueRoutingPayloadHash({ ...b, routing: 'stop', expectedVersion: '2' })).not.toBe(one);
    expect(venueRoutingPayloadHash({ ...b, routing: 'stop', reason: 'TEST other' })).not.toBe(one);
  });
});
