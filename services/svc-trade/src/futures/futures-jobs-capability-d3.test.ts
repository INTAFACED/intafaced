/**
 * Unit card — capabilities note has no D3 maintenance bps
 * 1. Promise: bots see ladderNumbers: d3_unset, never a maintenanceBps number
 * 2. Break: presentFuturesJobsCapabilityNote adds maintenanceBps from DEFAULT policy
 * 3. Done bar: source has ladderNumbers: 'd3_unset' and no maintenanceBps
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/futures-policy.ts
 * 6. RED: maintenanceBps: in the presenter
 * 7. Collision: none — new file only
 */

import { describe, expect, it } from 'vitest';
import { presentFuturesJobsCapabilityNote } from './futures-policy.js';

describe('capabilities futures note does not invent D3 bps', () => {
  it('ladderNumbers stays d3_unset and maintenanceBps is absent', () => {
    // Every flag on: the note still names the ladder as unset and carries no maintenance number.
    const note = presentFuturesJobsCapabilityNote({
      jobsEnabled: true,
      orderableEnabled: true,
      profitSourceConfigured: true,
      fundingMaxAbsRateConfigured: true,
      fundingMarketCount: 2,
      venueMarkConfigured: true,
      fundingIntervalConfigured: true,
    });
    expect(note.ladderNumbers).toBe('d3_unset');
    expect(note).not.toHaveProperty('maintenanceBps');
    expect(JSON.stringify(note)).not.toMatch(/maintenanceBps|tiers|uptoDepthBps/);
    // The presenter has no input for a ladder: none can be handed to it.
    // @ts-expect-error presentFuturesJobsCapabilityNote takes no maintenanceBps
    const smuggled = presentFuturesJobsCapabilityNote({ maintenanceBps: 50 });
    expect(smuggled).not.toHaveProperty('maintenanceBps');
  });
});
