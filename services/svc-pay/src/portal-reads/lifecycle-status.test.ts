import { describe, expect, it } from 'vitest';
import { DESTINATION_CHANGE_FLOW } from './destinations.js';
import { derivePayoutLifecycleStatus, type LifecycleKind } from './lifecycle-status.js';

describe('payout lifecycle status', () => {
  it('derives status from kinds in timeline order', () => {
    expect(derivePayoutLifecycleStatus(['settlement.opened', 'settlement.posted', 'rail.sent'])).toBe('posted');
    expect(derivePayoutLifecycleStatus(['settlement.opened', 'approval.rejected', 'settlement.posted', 'rail.confirmed'])).toBe('paid_out');
    expect(derivePayoutLifecycleStatus(['settlement.posted', 'rail.confirmed', 'payout.reversed'])).toBe('failed');
    const kinds: LifecycleKind[] = ['settlement.opened'];
    expect(derivePayoutLifecycleStatus(kinds)).toBe('pending');
  });

  it('treats destination remove and set-default as an owner write, not a reviewed change', () => {
    expect(DESTINATION_CHANGE_FLOW).toBe('owner_write');
  });
});
