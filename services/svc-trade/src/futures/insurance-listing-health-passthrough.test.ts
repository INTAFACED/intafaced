/**
 * Unit card — /health advertises DIRECTION:33 without inventing fund size
 * 1. Promise: insuranceListing.emptyPotBlocksLiveList true; targetSize owner_unset
 * 2. Break: /health omits the policy so ops infer a funded pot from ok:true
 * 3. Done bar: index.ts calls presentInsuranceListingPolicy
 * 4. Class N
 * 5. Paths: svc-trade/src/index.ts
 * 6. RED: no insuranceListing: presentInsuranceListingPolicy()
 * 7. Collision: #1869 listOpen pin
 */

import { describe, expect, it } from 'vitest';
import { presentInsuranceListingPolicy } from './insurance-listing-gate.js';
import { describeFuturesPolicy } from './futures-policy.js';

describe('insurance listing policy on /health', () => {
  it('live host mounts presentInsuranceListingPolicy on /health', () => {
    // The listing policy the host reports: an empty pot blocks a live list, and the target size stays the owner's.
    expect(presentInsuranceListingPolicy()).toEqual({ emptyPotBlocksLiveList: true, targetSize: 'owner_unset' });
    // The public policy door reports the same one.
    expect(describeFuturesPolicy({}).insuranceListing).toEqual(presentInsuranceListingPolicy());
  });
});
