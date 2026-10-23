import { describe, expect, it } from 'vitest';
import type { Candle } from '../../data/types';
import { advance, replayBars, replayStart, type Replay } from './replay';

const candle = (i: number): Candle => ({ t: i * 60_000, o: '1', h: '1', l: '1', c: '1', v: '1', filled: false });
const bars = Array.from({ length: 10 }, (_, i) => candle(i));

describe('bar replay', () => {
  it('starts the given number of bars back, or says why it cannot', () => {
    expect(replayStart(10, 3)).toEqual({ ok: true, position: 6 });
    expect(replayStart(10, 9)).toEqual({ ok: true, position: 0 });
    expect(replayStart(10, 10)).toEqual({ ok: false, reason: 'deep', most: 9 });
    expect(replayStart(10, 0)).toEqual({ ok: false, reason: 'least', most: 9 });
  });

  it('refuses a value that is not a whole number, rather than rounding it', () => {
    expect(replayStart(10, 2.5)).toEqual({ ok: false, reason: 'whole', most: 9 });
    expect(replayStart(10, Number.NaN)).toEqual({ ok: false, reason: 'whole', most: 9 });
  });

  it('never says "at most 0 bars back": with one bar or none there is no bar to start from', () => {
    expect(replayStart(1, 1)).toEqual({ ok: false, reason: 'few', most: 0 });
    expect(replayStart(0, 1)).toEqual({ ok: false, reason: 'few', most: 0 });
    expect(replayStart(2, 1)).toEqual({ ok: true, position: 0 });
  });

  it('draws the bars up to its position and leaves the bars themselves alone', () => {
    const replay: Replay = { bars, position: 6, playing: false, speed: 4 };
    expect(replayBars(bars, replay)).toHaveLength(7);
    expect(replayBars(bars, null)).toBe(bars);
    expect(bars).toHaveLength(10);
  });

  it('keeps the same cut and the same total when older history is prepended during replay', () => {
    const replay: Replay = { bars, position: 6, playing: false, speed: 1 };
    const older = [candle(-3), candle(-2), candle(-1), ...bars];
    // The frozen bars decide the cut: the older bars do not shift it or change the count.
    expect(replayBars(older, replay)).toEqual(bars.slice(0, 7));
    expect(replay.bars).toHaveLength(10);
    expect(replay.position + 1).toBe(7);
  });

  it('keeps the same cut when a polled window slides forward during replay', () => {
    const replay: Replay = { bars, position: 6, playing: false, speed: 1 };
    const slid = [...bars.slice(2), candle(10), candle(11)];
    expect(replayBars(slid, replay)).toEqual(bars.slice(0, 7));
  });

  it('advances one bar at a time and stops at the newest frozen bar', () => {
    let now: Replay = { bars, position: 7, playing: true, speed: 1 };
    now = advance(now);
    expect(now).toMatchObject({ position: 8, playing: true });
    now = advance(now);
    expect(now).toMatchObject({ position: 9, playing: false });
    expect(advance(now)).toMatchObject({ position: 9, playing: false });
  });
});
