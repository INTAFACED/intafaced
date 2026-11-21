import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRecord, sleep } from './index.js';
import { isRecord as isRecordFromSubpath } from './guards.js';

describe('isRecord', () => {
  it('accepts a plain object, an empty object and an object made without a prototype', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('refuses null, undefined, arrays and primitives', () => {
    for (const v of [null, undefined, [], [1], 0, 1, '', 'x', true, false, 1n, Symbol('s')]) expect(isRecord(v)).toBe(false);
  });

  it('accepts any other object, as every local copy it replaces does (it is not a plain-object check)', () => {
    expect(isRecord(new Date(0))).toBe(true);
    expect(isRecord(new Map())).toBe(true);
  });

  it('narrows so a field can be read without a cast', () => {
    const v: unknown = { n: 2 };
    if (!isRecord(v)) throw new Error('expected a record');
    expect(v.n).toBe(2);
  });

  it('is the same function from the barrel and from its own module', () => {
    expect(isRecordFromSubpath).toBe(isRecord);
  });
});

describe('sleep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves only after the given time has passed', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = sleep(50).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it('resolves to undefined', async () => {
    vi.useFakeTimers();
    const p = sleep(0);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBeUndefined();
  });
});
