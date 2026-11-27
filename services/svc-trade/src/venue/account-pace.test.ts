import { describe, expect, it } from 'vitest';
import { AccountPace, accountPaceSetting } from './account-pace.js';

// A background reader's pace is set by the account count, so its weight at the venue stays the same however many
// accounts there are.

const id = (s: string) => s;
const accounts = (n: number) => Array.from({ length: n }, (_, i) => `acct-${String(i).padStart(3, '0')}`);

function clock(startMs = Date.UTC(2026, 10, 27, 11, 0, 0)) {
  let ms = startMs;
  return { now: () => new Date(ms), advance: (by: number) => (ms += by) };
}

describe('the account pace', () => {
  it('reads no more accounts a minute than its pace, however many accounts there are', () => {
    for (const n of [10, 50, 500]) {
      const c = clock();
      const pace = new AccountPace(24, c.now);
      let read = 0;
      // A tick every 15 s for ten minutes, as the balance watch on the test network.
      for (let t = 0; t < 40; t++) {
        read += pace.take(accounts(n), id).due.length;
        c.advance(15_000);
      }
      // One minute's credit at the start, then 24 a minute: never more than 24 × 11 in ten minutes.
      expect(read).toBeLessThanOrEqual(Math.min(n * 40, 24 * 11));
      expect(read).toBeGreaterThanOrEqual(Math.min(n * 40, 24 * 9));
    }
  });

  it('reads every account in turn, each once a round, and names where the round began', () => {
    const c = clock();
    const pace = new AccountPace(4, c.now);
    const all = accounts(10);
    const began = c.now();
    const seen: string[] = [];
    const first = pace.take(all, id);
    expect(first.due).toEqual(all.slice(0, 4));
    expect(first.round).toEqual({ began, ends: false });
    seen.push(...first.due);
    c.advance(60_000);
    const second = pace.take(all, id);
    expect(second.due).toEqual(all.slice(4, 8));
    seen.push(...second.due);
    c.advance(60_000);
    // Never past the end of a round: two left, though four are due.
    const third = pace.take(all, id);
    expect(third.due).toEqual(all.slice(8));
    expect(third.round).toEqual({ began, ends: true });
    seen.push(...third.due);
    expect(seen).toEqual(all);
    c.advance(1);
    const fourth = pace.take(all, id);
    expect(fourth.due).toEqual(all.slice(0, 2));
    expect(fourth.round.began).toEqual(c.now());
  });

  it('carries on after the last account read when accounts come and go, and starts again when none comes after it', () => {
    const c = clock();
    const pace = new AccountPace(2, c.now);
    expect(pace.take(['b', 'd', 'f'], id).due).toEqual(['b', 'd']);
    c.advance(60_000);
    expect(pace.take(['a', 'c', 'e', 'f'], id).due).toEqual(['e', 'f']);
    c.advance(30_000);
    expect(pace.take(['a', 'b'], id).due).toEqual(['a']);
    c.advance(30_000);
    const gone = pace.take(['a'], id);
    // 'a' was the last read and nothing comes after it: a new round from the first.
    expect(gone.due).toEqual(['a']);
    expect(gone.round.ends).toBe(true);
  });

  it('a quiet minute does not turn into a burst: credit is held up to one minute', () => {
    const c = clock();
    const pace = new AccountPace(6, c.now);
    expect(pace.take(accounts(100), id).due).toHaveLength(6);
    c.advance(60 * 60_000);
    expect(pace.take(accounts(100), id).due).toHaveLength(6);
    c.advance(10_000);
    expect(pace.take(accounts(100), id).due).toHaveLength(1);
  });

  it('a round with an account not read is not clean; the next round starts clean', () => {
    const c = clock();
    const pace = new AccountPace(2, c.now);
    pace.take(['a', 'b', 'c'], id);
    pace.spoilRound();
    c.advance(60_000);
    const end = pace.take(['a', 'b', 'c'], id);
    expect(end.round.ends).toBe(true);
    expect(pace.roundIsClean).toBe(false);
    c.advance(60_000);
    pace.take(['a', 'b', 'c'], id);
    expect(pace.roundIsClean).toBe(true);
  });

  it('an account that joins behind the current position leaves the round not clean, and is read in the next', () => {
    const c = clock();
    const pace = new AccountPace(2, c.now);
    expect(pace.take(['b', 'c', 'd'], id).due).toEqual(['b', 'c']);
    c.advance(60_000);
    const end = pace.take(['a', 'b', 'c', 'd'], id);
    expect(end.due).toEqual(['d']);
    expect(end.round.ends).toBe(true);
    expect(pace.roundIsClean).toBe(false);
    c.advance(60_000);
    expect(pace.take(['a', 'b', 'c', 'd'], id).due).toEqual(['a', 'b']);
    c.advance(60_000);
    expect(pace.take(['a', 'b', 'c', 'd'], id).round.ends).toBe(true);
    expect(pace.roundIsClean).toBe(true);
  });

  it('no pace reads every account on every take, each take a whole round', () => {
    const c = clock();
    const pace = new AccountPace(null, c.now);
    for (let i = 0; i < 3; i++) expect(pace.take(accounts(50), id)).toEqual({ due: accounts(50), round: { began: c.now(), ends: true } });
  });

  it('the setting is blank or a whole number above zero; anything else refuses at start-up', () => {
    expect(accountPaceSetting('', 'X')).toBeNull();
    expect(accountPaceSetting(' 24 ', 'X')).toBe(24);
    for (const bad of ['0', '-1', '2.5', 'many', '1e3']) expect(() => accountPaceSetting(bad, 'X')).toThrow(/X must be blank/);
    expect(() => new AccountPace(0, () => new Date())).toThrow(/above zero/);
  });
});
