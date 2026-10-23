import { describe, expect, it } from 'vitest';
import {
  applyChange,
  cellsFor,
  DEFAULT_GRID,
  followers,
  isGridSetting,
  limitedLayoutAfter,
  layoutRefusal,
  reasonFor,
  resize,
  withVisible,
  type CellSetting,
  type LimitRead,
} from './grid';

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

  it('shows a stored layout only once the limit is read and allows it', () => {
    const read = (limit: LimitRead) => reasonFor('grid', limit);
    expect(read({ ok: true, value: 4 })).toBeNull();
    expect(read({ ok: true, value: 2 })).toBe('over');
    expect(read({ ok: false, why: 'unset' })).toBe('unset');
    expect(read({ ok: false, why: 'unavailable' })).toBe('unavailable');
    expect(read({ ok: false, why: 'loading' })).toBe('loading');
    // One chart is never refused, whatever the limit is.
    expect(reasonFor('single', { ok: false, why: 'loading' })).toBeNull();
  });

  it('moves to the next layout the limit allows, and to none while it loads', () => {
    const ok = (value: number): LimitRead => ({ ok: true, value });
    expect(limitedLayoutAfter('single', ok(4))).toBe('two-across');
    // From two down the four-chart grid is skipped at a limit of two, and the cycle goes on to one chart.
    expect(limitedLayoutAfter('two-down', ok(2))).toBe('single');
    expect(limitedLayoutAfter('single', ok(1))).toBeNull();
    expect(limitedLayoutAfter('single', { ok: false, why: 'loading' })).toBeNull();
  });

  it('keeps stored cells that a smaller layout is not showing', () => {
    const stored = [cell('ETH/USDT'), cell('SOL/USDT'), cell('XRP/USDT')];
    expect(withVisible(stored, [])).toEqual(stored);
    expect(withVisible(stored, [cell('BTC/USDT')])).toEqual([cell('BTC/USDT'), cell('SOL/USDT'), cell('XRP/USDT')]);
  });
});
