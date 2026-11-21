import { describe, expect, it } from 'vitest';
import {
  allowsPersistenceClaim,
  allowsQuietMarketBook,
  CAPTURE_LAKE_RECORD_KINDS,
  describeCaptureLakePolicy,
  wouldCollapseHoleToEmptyBook,
} from './capture-lake-policy.js';
import * as fabric from './index.js';

describe('describeCaptureLakePolicy — connect.data-lake fabric honesty door', () => {
  it('states hole vs quiet-market honesty without promising a time-series store', () => {
    const p = describeCaptureLakePolicy();
    expect(p.recordKinds).toEqual(CAPTURE_LAKE_RECORD_KINDS);
    expect(p.unconnectedVenueIsHole).toBe(true);
    expect(p.quietMarketIsBookNotHole).toBe(true);
    expect(p.holeNotSyntheticEmptyBook).toBe(true);
    expect(p.bookFromCaptureNullOnHole).toBe(true);
    expect(p.midFromCaptureNeverInvented).toBe(true);
    expect(p.holeRoutingWeightZero).toBe(true);
    expect(p.noTsdbInModule).toBe(true);
    expect(p.inventsQuietMarket).toBe(false);
    expect(p.inventsMids).toBe(false);
  });
});

describe('capture-lake policy enforcement', () => {
  it('allows quiet-market book only when adapter is present and id-matched', () => {
    expect(allowsQuietMarketBook(true, true)).toBe(true);
    expect(allowsQuietMarketBook(false, true)).toBe(false);
    expect(allowsQuietMarketBook(true, false)).toBe(false);
    expect(allowsQuietMarketBook(false, false)).toBe(false);
  });

  it('detects synthetic quiet-market invention from absent or mismatched adapters', () => {
    expect(wouldCollapseHoleToEmptyBook(false, true)).toBe(true);
    expect(wouldCollapseHoleToEmptyBook(true, false)).toBe(true);
    expect(wouldCollapseHoleToEmptyBook(true, true)).toBe(false);
  });

  it('refuses persistence claims in in-memory capture', () => {
    expect(allowsPersistenceClaim('tsdb')).toBe(false);
    expect(allowsPersistenceClaim('retention')).toBe(false);
    expect(allowsPersistenceClaim('compose')).toBe(false);
  });
});

describe('capture-lake-policy public door — fabric export seal', () => {
  it('fabric/index exports the capture-lake policy door itself', () => {
    expect(fabric.describeCaptureLakePolicy).toBe(describeCaptureLakePolicy);
    expect(fabric.allowsQuietMarketBook).toBe(allowsQuietMarketBook);
    expect(fabric.wouldCollapseHoleToEmptyBook).toBe(wouldCollapseHoleToEmptyBook);
    expect(fabric.allowsPersistenceClaim).toBe(allowsPersistenceClaim);
    expect(fabric.CAPTURE_LAKE_RECORD_KINDS).toBe(CAPTURE_LAKE_RECORD_KINDS);
    expect(fabric.describeCaptureLakePolicy().holeNotSyntheticEmptyBook).toBe(true);
  });
});
