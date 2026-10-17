import { describe, expect, it } from 'vitest';
import { bucketOf, cancelCounts, type CancelRow } from './cancelAll';

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

describe('cancelCounts while the run is going', () => {
  it('counts orders not reached yet as still to go, not as not sent', () => {
    const c = cancelCounts([row('a', 'cancelled')], 4, { running: true });
    expect(c).toMatchObject({ cancelled: 1, notSent: 0, pending: 3 });
  });

  it('moves them to not sent once the run has ended', () => {
    const c = cancelCounts([row('a', 'cancelled')], 4, { running: false });
    expect(c).toMatchObject({ cancelled: 1, notSent: 3, pending: 0 });
  });

  it('keeps a recorded not-sent row in not sent while running, and still adds up to the total', () => {
    const c = cancelCounts([row('a', 'cancelled'), row('b', 'notSent')], 5, { running: true });
    expect(c).toMatchObject({ notSent: 1, pending: 3 });
    expect(c.cancelled + c.refused + c.unconfirmed + c.notSent + c.pending).toBe(5);
  });

  it('counts every order as still to go before the first answer', () => {
    expect(cancelCounts([], 4, { running: true })).toMatchObject({ cancelled: 0, notSent: 0, pending: 4 });
  });
});

describe('bucketOf', () => {
  const words = { title: 'TEST', body: 'TEST' } as never;
  it('puts a verified answer in cancelled and carries on', () => {
    expect(bucketOf({ kind: 'done', data: null })).toEqual({ bucket: 'cancelled', stop: false });
  });

  it('puts a service refusal in refused and carries on', () => {
    expect(bucketOf({ kind: 'refused', words })).toEqual({ bucket: 'refused', stop: false });
  });

  it('puts a request that never left in notSent and stops, never refused', () => {
    const r = bucketOf({ kind: 'blocked', reason: 'pending' });
    expect(r).toEqual({ bucket: 'notSent', stop: true });
    expect(r.bucket).not.toBe('refused');
  });

  it('puts a lost answer in unconfirmed and stops, never cancelled or refused', () => {
    const r = bucketOf({ kind: 'uncertain', id: 'TEST-1', words });
    expect(r).toEqual({ bucket: 'unconfirmed', stop: true });
    expect(r.bucket).not.toBe('cancelled');
    expect(r.bucket).not.toBe('refused');
  });

  it('writes no row for idle and stops', () => {
    expect(bucketOf({ kind: 'idle' })).toEqual({ bucket: null, stop: true });
  });
});
