import { describe, expect, it } from 'vitest';
import { applyDelta, bookFromSnapshot, emptyBook, ingestVenueDepthSnapshot } from './depth.js';
import { DEPTH_ABSENT_REFUSE_REASON, DEPTH_GAP_REFUSE_REASON, DEPTH_STALE_REFUSE_REASON, describeDepthPolicy } from './depth-policy.js';
import { CaptureLog } from '@intafaced/connect-data-lake';

const MARKET = 'BTC-USDT';

describe('describeDepthPolicy', () => {
  it('states absolute deltas with gap and stale refuse, not synthetic empty books', () => {
    const p = describeDepthPolicy();
    expect(p.absoluteDeltaLevels).toBe(true);
    expect(p.zeroQuantityRemovesLevel).toBe(true);
    expect(p.absentLevelMeansUnchanged).toBe(true);
    expect(p.gapRefusesApply).toBe(true);
    expect(p.gapRefuseReason).toBe(DEPTH_GAP_REFUSE_REASON);
    expect(p.staleRefusesApply).toBe(true);
    expect(p.staleRefuseReason).toBe(DEPTH_STALE_REFUSE_REASON);
    expect(p.resnapshotOnGap).toBe(true);
    expect(p.holeNotSyntheticEmptyBook).toBe(true);
    expect(p.absentRefuseReason).toBe(DEPTH_ABSENT_REFUSE_REASON);
    expect(p.inventsQuietMarket).toBe(false);
    expect(p.inventsPhantomLiquidity).toBe(false);
  });

  it('matches applyDelta gap and stale refusal semantics', () => {
    const p = describeDepthPolicy();
    const book = bookFromSnapshot({
      type: 'snapshot',
      marketId: MARKET,
      sequence: 10,
      bids: [['100', '5']],
      asks: [],
    });

    const gap = applyDelta(book, {
      type: 'delta',
      marketId: MARKET,
      fromSequence: 12,
      sequence: 13,
      bids: [],
      asks: [],
    });
    expect(gap.ok).toBe(false);
    if (gap.ok) return;
    expect(gap.reason).toBe(p.gapRefuseReason);

    const stale = applyDelta(book, {
      type: 'delta',
      marketId: MARKET,
      fromSequence: 9,
      sequence: 10,
      bids: [],
      asks: [],
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.reason).toBe(p.staleRefuseReason);
  });

  it('matches ingestVenueDepthSnapshot absent hole — never emptyBook', () => {
    const p = describeDepthPolicy();
    const lake = new CaptureLog({ now: () => new Date('2026-08-16T13:00:00.000Z') });
    const result = ingestVenueDepthSnapshot(lake, {
      venueId: 'unwired-venue',
      marketId: MARKET,
      connection: 'not_connected',
    });

    expect(result.book).toBeNull();
    expect(result.book).not.toEqual(emptyBook(MARKET));
    expect(p.holeNotSyntheticEmptyBook).toBe(true);
    expect(result.record).toMatchObject({ status: 'absent' });
  });
});
