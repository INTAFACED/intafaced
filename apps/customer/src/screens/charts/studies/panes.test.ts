import { describe, expect, it } from 'vitest';
import {
  addStudy,
  EMPTY_STORE,
  isStudyStore,
  movePane,
  panesOf,
  PANE_SIZE_MAX,
  PANE_SIZE_MIN,
  removeStudy,
  resizePane,
  setPaneSizes,
  toggleCollapsed,
  toggleMaximised,
  toggleOnMain,
} from './model';
import { paneFactors } from './useStudyDraw';

const withPanes = () => addStudy(addStudy(addStudy(EMPTY_STORE, 'rsi'), 'macd'), 'sma');

describe('indicator panes', () => {
  it('moves a pane up and down among the panes drawn, never past the ends', () => {
    const store = withPanes();
    const order = ['rsi-1', 'macd-1'];
    const moved = movePane(store, 'macd-1', -1, order);
    expect(moved.studies.map((s) => s.id)).toEqual(['macd-1', 'rsi-1', 'sma-1']);
    expect(movePane(store, 'rsi-1', -1, order)).toBe(store);
    expect(movePane(store, 'macd-1', 1, order)).toBe(store);
  });

  it('collapses, maximises and moves a pane to the main pane and back; moving to main ends its maximise', () => {
    let store = withPanes();
    store = toggleCollapsed(store, 'rsi-1');
    expect(panesOf(store).collapsed).toEqual(['rsi-1']);
    store = toggleMaximised(store, 'macd-1');
    expect(panesOf(store).maximised).toBe('macd-1');
    store = toggleOnMain(store, 'macd-1');
    expect(panesOf(store)).toMatchObject({ onMain: ['macd-1'], maximised: null });
    store = toggleOnMain(toggleCollapsed(store, 'rsi-1'), 'macd-1');
    expect(panesOf(store)).toMatchObject({ onMain: [], collapsed: [] });
  });

  it('sizes stay within bounds, whether stepped or read back from a drag', () => {
    let store = withPanes();
    for (let i = 0; i < 10; i += 1) store = resizePane(store, 'rsi-1', 1.5);
    expect(panesOf(store).sizes['rsi-1']).toBe(PANE_SIZE_MAX);
    store = setPaneSizes(store, { 'rsi-1': 0.01, 'macd-1': 2 });
    expect(panesOf(store).sizes).toEqual({ 'rsi-1': PANE_SIZE_MIN, 'macd-1': 2 });
  });

  it('a removed study leaves no pane setting behind', () => {
    let store = toggleMaximised(toggleOnMain(toggleCollapsed(resizePane(withPanes(), 'rsi-1', 1.5), 'rsi-1'), 'macd-1'), 'rsi-1');
    store = removeStudy(removeStudy(store, 'rsi-1'), 'macd-1');
    expect(panesOf(store)).toEqual({ onMain: [], collapsed: [], sizes: {}, maximised: null });
  });

  it('a stored layout is kept when it has the shape; a store saved before panes reads; a bad layout falls back, the studies kept', () => {
    const store = toggleCollapsed(withPanes(), 'rsi-1');
    const saved = JSON.parse(JSON.stringify(store));
    expect(isStudyStore(saved)).toBe(true);
    expect(panesOf(saved).collapsed).toEqual(['rsi-1']);
    expect(isStudyStore({ ...store, panes: undefined })).toBe(true);
    const bad = { ...store, panes: { onMain: 'rsi-1', collapsed: [], sizes: {} } } as unknown as typeof store;
    expect(isStudyStore(bad)).toBe(true);
    expect(panesOf(bad)).toEqual({ onMain: [], collapsed: [], sizes: {}, maximised: null });
    expect(bad.studies).toHaveLength(3);
    // A stored size out of bounds is held to them when read.
    expect(
      panesOf({ ...store, panes: { onMain: [], collapsed: [], sizes: { 'rsi-1': -2, 'macd-1': 99 }, maximised: null } }).sizes,
    ).toEqual({
      'rsi-1': PANE_SIZE_MIN,
      'macd-1': PANE_SIZE_MAX,
    });
  });

  it('stretch factors: the main pane three shares, a pane its size, a collapsed pane a strip, a maximised pane nearly all', () => {
    const groups = ['rsi-1', 'macd-1'];
    expect(paneFactors(groups, { onMain: [], collapsed: [], sizes: { 'macd-1': 2 }, maximised: null })).toEqual([3, 1, 2]);
    const [main, rsi, macd] = paneFactors(groups, { onMain: [], collapsed: ['rsi-1'], sizes: {}, maximised: null });
    expect(rsi).toBeLessThan(0.1 * main!);
    expect(macd).toBe(1);
    const max = paneFactors(groups, { onMain: [], collapsed: [], sizes: {}, maximised: 'macd-1' });
    expect(max[2]).toBeGreaterThan(10 * (max[0]! + max[1]!));
    // A maximised id with no pane drawn changes nothing.
    expect(paneFactors(groups, { onMain: [], collapsed: [], sizes: {}, maximised: 'gone-1' })).toEqual([3, 1, 1]);
  });
});
