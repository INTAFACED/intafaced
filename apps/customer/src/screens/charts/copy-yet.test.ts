import { describe, expect, it } from 'vitest';
import { chartsMessages } from './copy';

/**
 * Unit card — charts copy never promises a later state
 *
 * 1. Promise: a chart line states where the data stands now. "yet" is a promise that a state will change, so it is never
 *    shown on the chart (the copy-promises guard covers the wider app; this one reads the charts catalogue directly).
 * 2. Break: "No candles yet" told a person the candles would come later, and the guard's pattern list did not catch it.
 * 3. Done bar: no value in the charts catalogue contains "yet".
 */
describe('charts copy: no line promises a later state', () => {
  it('no charts line contains the word yet', () => {
    const values = Object.values(chartsMessages);
    expect(values.length).toBeGreaterThan(0);
    expect(values.filter((v) => /\byet\b/i.test(v))).toEqual([]);
  });
});
