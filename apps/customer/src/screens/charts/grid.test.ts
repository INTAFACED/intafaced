import { describe, expect, it } from 'vitest';
import { applyChange, cellsFor, followers, isGridSetting, layoutRefusal, resize, DEFAULT_GRID, type CellSetting } from './grid';

const cell = (symbol: string, group: CellSetting['group'] = 'blue'): CellSetting => ({ symbol, interval: '15m', mode: 'candles', group });
const ALL = { symbol: true, interval: true, crosshair: true, range: true };

describe('chart grid', () => {
  it('refuses more than one chart while the owner limit is blank, and past the limit once set', () => {
    expect(layoutRefusal('single', null)).toBeNull();
    expect(layoutRefusal('grid', null)).toBe('unset');
    expect(layoutRefusal('grid', 2)).toBe('over');
    expect(layoutRefusal('two-across', 2)).toBeNull();
  });

  it('fills new cells from the first chart, in the blue group, and keeps stored ones', () => {
    const cells = cellsFor('grid', cell('BTC/USDT'), [cell('ETH/USDT', null)]);
    expect(cells.map((c) => [c.symbol, c.group])).toEqual([
      ['BTC/USDT', 'blue'],
      ['ETH/USDT', null],
      ['BTC/USDT', 'blue'],
      ['BTC/USDT', 'blue'],
    ]);
  });

  it('applies a change to the charts of the same group only, and only for the linked parts', () => {
    const cells = [cell('BTC/USDT'), cell('BTC/USDT'), cell('BTC/USDT', 'green'), cell('BTC/USDT', null)];
    const next = applyChange(cells, 0, { symbol: 'ETH/USDT', interval: '1h' }, { ...ALL, interval: false });
    expect(next.map((c) => [c.symbol, c.interval])).toEqual([
      ['ETH/USDT', '1h'],
      ['ETH/USDT', '15m'],
      ['BTC/USDT', '15m'],
      ['BTC/USDT', '15m'],
    ]);
    // A chart with no group changes alone.
    expect(applyChange(cells, 3, { symbol: 'ETH/USDT' }, ALL).map((c) => c.symbol)).toEqual([
      'BTC/USDT',
      'BTC/USDT',
      'BTC/USDT',
      'ETH/USDT',
    ]);
    expect(followers(cells, 0)).toEqual([1]);
    expect(followers(cells, 3)).toEqual([]);
  });

  it('moves border weight without letting a track go below a fifth', () => {
    expect(resize([1, 1], 0.25)).toEqual([1.5, 0.5]);
    const [a, b] = resize([1, 1], 0.9);
    expect(a).toBeCloseTo(1.6);
    expect(b).toBeCloseTo(0.4);
  });

  it('reads back only a well-formed stored grid', () => {
    expect(isGridSetting(DEFAULT_GRID)).toBe(true);
    expect(isGridSetting({ ...DEFAULT_GRID, layout: 'nine' })).toBe(false);
    expect(isGridSetting({ ...DEFAULT_GRID, sizes: { cols: [1], rows: [1, 1] } })).toBe(false);
  });
});
