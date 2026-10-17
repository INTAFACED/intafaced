import { describe, expect, it } from 'vitest';
import * as commands from './operator-commands';
import { RECONCILE_AVAILABILITY } from './operator-commands';

/**
 * Reconcile has no wire, so it must have no numbers. This file used to pin a labelled-zero simulation; the pin is
 * now that no simulation exists to be mistaken for the book.
 */
describe('ledger reconcile is unavailable, and says so without inventing a figure', () => {
  it('reports unavailable with a reason that names the missing route', () => {
    expect(RECONCILE_AVAILABILITY.available).toBe(false);
    expect(RECONCILE_AVAILABILITY.reason).toContain('no reconcile route');
  });

  it('exports no function that could return a simulated report', () => {
    expect(Object.keys(commands).sort()).toEqual(['RECONCILE_AVAILABILITY']);
    expect(JSON.stringify(RECONCILE_AVAILABILITY)).not.toMatch(/accountsChecked|chainLength|unbalancedAssets|simulated/);
  });
});
