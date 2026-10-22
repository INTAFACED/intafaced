import { describe, expect, it } from 'vitest';
import type { Candle } from '../../data/types';
import { replayBars, replayStart } from './replay';

const bars = Array.from({ length: 10 }, (_, i): Candle => ({ t: i * 60_000, o: '1', h: '1', l: '1', c: '1', v: '1', filled: false }));

describe('bar replay', () => {
  it('starts the given number of bars back, or says how deep it can go', () => {
    expect(replayStart(10, 3)).toEqual({ ok: true, position: 6 });
    expect(replayStart(10, 10)).toEqual({ ok: false, most: 9 });
    expect(replayStart(10, 0)).toEqual({ ok: false, most: 9 });
  });

  it('draws the bars up to its position and leaves the bars themselves alone', () => {
    expect(replayBars(bars, { position: 6, playing: false, speed: 4 })).toHaveLength(7);
    expect(replayBars(bars, null)).toBe(bars);
    expect(bars).toHaveLength(10);
  });
});
