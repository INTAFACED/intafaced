import { describe, expect, it } from 'vitest';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

describe('resolveP2pCopy — catalog keys, never invented English', () => {
  it('returns a key that is not in the catalog as the key itself', () => {
    const key = 'p2p.offer.surface.that.was.never.keyed';
    expect(resolveP2pCopy(key)).toBe(key);
  });

  it('unknown key does not invent copy', () => {
    const key = 'p2p.instrument.surface.that.was.never.keyed';
    const rendered = resolveP2pCopy(key);
    expect(rendered).toBe(key);
    expect(rendered).not.toMatch(/something went wrong/i);
    expect(rendered).not.toMatch(/try again/i);
    expect(rendered).not.toMatch(/cannot be taken/i);
    expect(rendered).not.toContain(' ');
  });

  it('resolves a key that already exists on tip', () => {
    expect(resolveP2pCopy('error.generic')).toBe('Something went wrong. Try again.');
  });

  it('offer/instrument refuse keys stay the dotted name until a catalog row lands', () => {
    expect(resolveP2pCopy(P2P_COPY.takeRefused)).toBe(P2P_COPY.takeRefused);
    expect(resolveP2pCopy(P2P_COPY.methodUnknown)).toBe(P2P_COPY.methodUnknown);
    expect(resolveP2pCopy(P2P_COPY.offerMethodsRequired)).toBe(P2P_COPY.offerMethodsRequired);
    expect(resolveP2pCopy(P2P_COPY.offerMethodNoDestination)).toBe(P2P_COPY.offerMethodNoDestination);
    expect(resolveP2pCopy(P2P_COPY.instrumentKmsRequired)).toBe(P2P_COPY.instrumentKmsRequired);
    expect(resolveP2pCopy(P2P_COPY.offerListLimitUnset)).toBe(P2P_COPY.offerListLimitUnset);
    expect(resolveP2pCopy(P2P_COPY.disputeListLimitUnset)).toBe(P2P_COPY.disputeListLimitUnset);
    expect(resolveP2pCopy(P2P_COPY.lateSettlementsListLimitUnset)).toBe(P2P_COPY.lateSettlementsListLimitUnset);
    expect(resolveP2pCopy(P2P_COPY.tradeListLimitUnset)).toBe(P2P_COPY.tradeListLimitUnset);
    expect(resolveP2pCopy(P2P_COPY.sweepSettlementsLimitUnset)).toBe(P2P_COPY.sweepSettlementsLimitUnset);
    expect(resolveP2pCopy(P2P_COPY.sweepDeadlinesLimitUnset)).toBe(P2P_COPY.sweepDeadlinesLimitUnset);
    expect(resolveP2pCopy(P2P_COPY.instrumentListLimitUnset)).toBe(P2P_COPY.instrumentListLimitUnset);
    expect(resolveP2pCopy(P2P_COPY.accessLogLimitUnset)).toBe(P2P_COPY.accessLogLimitUnset);
    expect(resolveP2pCopy(P2P_COPY.purgeSnapshotsLimitUnset)).toBe(P2P_COPY.purgeSnapshotsLimitUnset);
    expect(resolveP2pCopy(P2P_COPY.merchantHistoryLimitUnset)).toBe(P2P_COPY.merchantHistoryLimitUnset);
    expect(resolveP2pCopy(P2P_COPY.reviewListLimitUnset)).toBe(P2P_COPY.reviewListLimitUnset);
  });
});
