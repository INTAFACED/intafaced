import { describe, expect, it } from 'vitest';
import { rememberLastTrade } from './market-state';

const ready = (data: number | null) => ({ status: 'ready' as const, data, asOf: 0 });
const failed = { status: 'error' as const, retry: () => {} };

describe('rememberLastTrade: the newest trade this tab has read, kept through an outage', () => {
  it('gives nothing for a market never read, and never guesses one from a failed or empty read', () => {
    expect(rememberLastTrade('NEVER/READ', failed)).toBeNull();
    expect(rememberLastTrade('NEVER/READ', ready(null))).toBeNull();
    expect(rememberLastTrade('NEVER/READ', { status: 'loading' })).toBeNull();
  });

  it('keeps the newest time read once the tape stops answering, per market', () => {
    expect(rememberLastTrade('KEEP/A', ready(1_000))).toBe(1_000);
    expect(rememberLastTrade('KEEP/A', failed)).toBe(1_000);
    expect(rememberLastTrade('KEEP/B', failed)).toBeNull();
  });

  it('only moves forward: an older answer never replaces a newer trade', () => {
    rememberLastTrade('FWD/A', ready(5_000));
    expect(rememberLastTrade('FWD/A', ready(4_000))).toBe(5_000);
    expect(rememberLastTrade('FWD/A', ready(6_000))).toBe(6_000);
  });
});
