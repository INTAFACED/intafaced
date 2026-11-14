import { describe, expect, it } from 'vitest';
import type { VenueUp } from '../../features/trade/venue-api';
import { launchStanding } from './HomeStanding';

const venue = { available: true } as unknown as VenueUp;

describe('launchStanding (J-home-ia-01 #1, J-cex-spot-01 #1)', () => {
  it('is null while the user-venue door is off', () => {
    expect(launchStanding(null, { status: 'loading' })).toBeNull();
  });

  it('is the launch total for a person the bank answers for', () => {
    expect(launchStanding(venue, { status: 'loading' })).toBe(venue);
    expect(launchStanding(venue, { status: 'error', retry: () => {} })).toBe(venue);
  });

  it('keeps the verification ask while the bank refuses Home for verification', () => {
    expect(launchStanding(venue, { status: 'refused', code: 'denied.kyc_required' })).toBeNull();
  });

  it('a refusal for another reason still shows the launch total', () => {
    expect(launchStanding(venue, { status: 'refused', code: 'denied.region_blocked' })).toBe(venue);
  });
});
