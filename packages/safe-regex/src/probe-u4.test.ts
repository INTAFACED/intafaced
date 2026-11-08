import { describe, expect, it } from 'vitest';

// Probe (U4, do not merge): a planted failing test, so a required CI job is red.
describe('probe U4', () => {
  it('fails on purpose', () => {
    expect(1 + 1).toBe(3);
  });
});
