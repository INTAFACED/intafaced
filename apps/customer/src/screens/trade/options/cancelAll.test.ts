import { describe, expect, it } from 'vitest';
import { cancelCounts, type CancelRow } from './cancelAll';

const row = (id: string, bucket: CancelRow['bucket']): CancelRow => ({ id, symbol: `TEST-${id}`, bucket, text: bucket });

describe('cancelCounts', () => {
  it('counts only cancelled rows as cancelled', () => {
    const c = cancelCounts([row('a', 'cancelled'), row('b', 'cancelled')], 2);
    expect(c).toMatchObject({ cancelled: 2, refused: 0, unconfirmed: 0, notSent: 0, total: 2 });
  });

  it('keeps refused (service said no) apart from everything else', () => {
    const c = cancelCounts([row('a', 'refused'), row('b', 'cancelled')], 2);
    expect(c).toMatchObject({ cancelled: 1, refused: 1, unconfirmed: 0, notSent: 0 });
  });

  it('counts unconfirmed rows on their own, never as cancelled or refused', () => {
    const c = cancelCounts([row('a', 'unconfirmed')], 1);
    expect(c).toMatchObject({ cancelled: 0, refused: 0, unconfirmed: 1, notSent: 0 });
  });

  it('counts a blocked row as not sent, not refused', () => {
    const c = cancelCounts([row('a', 'notSent')], 1);
    expect(c).toMatchObject({ cancelled: 0, refused: 0, unconfirmed: 0, notSent: 1 });
  });

  it('counts orders the run never reached as not sent', () => {
    const c = cancelCounts([row('a', 'cancelled'), row('b', 'unconfirmed')], 5);
    expect(c).toMatchObject({ cancelled: 1, unconfirmed: 1, notSent: 3, total: 5 });
  });

  it('adds up to the total for a mix of every outcome', () => {
    const rows = [row('a', 'cancelled'), row('b', 'refused'), row('c', 'cancelled'), row('d', 'unconfirmed'), row('e', 'notSent')];
    const c = cancelCounts(rows, 7);
    expect(c).toMatchObject({ cancelled: 2, refused: 1, unconfirmed: 1, notSent: 3, total: 7 });
    expect(c.cancelled + c.refused + c.unconfirmed + c.notSent).toBe(7);
  });
});
