import { describe, expect, it } from 'vitest';
import { PREVIEW_LABEL as CONTRACT_LABEL } from '@intafaced/contracts';
import { PREVIEW_LABEL, SAMPLE } from './DomTab';

describe('DOM preview', () => {
  it('carries the preview contract’s own banner text', () => {
    expect(PREVIEW_LABEL).toBe(CONTRACT_LABEL);
  });
  it('holds only round illustrative levels, asks over bids, each side on its own rows', () => {
    expect(SAMPLE.every((l) => /^\d+\.00$/.test(l.price))).toBe(true);
    expect(SAMPLE.every((l) => (l.bid === null) !== (l.ask === null))).toBe(true);
    const asks = SAMPLE.filter((l) => l.ask !== null).map((l) => BigInt(l.price.replace('.', '')));
    const bids = SAMPLE.filter((l) => l.bid !== null).map((l) => BigInt(l.price.replace('.', '')));
    expect(asks.every((a) => bids.every((b) => a > b))).toBe(true);
  });
});
