import { describe, expect, it } from 'vitest';
import {
  parseSavedScreens,
  parseWatchlists,
  SAVED_SCREEN_CAP_EXCEEDED,
  SAVED_SCREEN_CAP_UNSET,
  WATCHLIST_CAP_EXCEEDED,
  WATCHLIST_LIST_CAP_UNSET,
  WATCHLIST_SYMBOL_CAP_UNSET,
} from './watchlists.js';

const list = (symbols: string[], id = 'majors') => ({
  id,
  name: 'Majors',
  flag: null,
  sections: [{ id: 'main', title: 'Main', collapsed: false, symbols }],
});
const caps = { listCap: 3, symbolCap: 2, savedScreenCap: 2 };
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
};

describe('watchlists (trade.watchlists)', () => {
  it('keeps a list under the caps and returns it unchanged', () => {
    const value = [list(['BTC/USDT', 'ETH/USDT'])];
    expect(parseWatchlists(value, caps)).toEqual(value);
    expect(parseWatchlists([], caps)).toEqual([]);
  });
  it('refuses a symbol list over the per-list cap, as a whole', () => {
    expect(codeOf(() => parseWatchlists([list(['BTC/USDT', 'ETH/USDT', 'IFC/USDT'])], caps))).toBe(WATCHLIST_CAP_EXCEEDED);
  });
  it('refuses more named lists than the list cap', () => {
    const lists = ['a', 'b', 'c', 'd'].map((id) => list([], id));
    expect(codeOf(() => parseWatchlists(lists, caps))).toBe(WATCHLIST_CAP_EXCEEDED);
  });
  it('refuses a symbol when the symbol cap is blank, and a named list when the list cap is blank', () => {
    expect(codeOf(() => parseWatchlists([list(['BTC/USDT'])], { listCap: 3, symbolCap: null, savedScreenCap: null }))).toBe(
      WATCHLIST_SYMBOL_CAP_UNSET,
    );
    expect(codeOf(() => parseWatchlists([list([])], { listCap: null, symbolCap: 2, savedScreenCap: null }))).toBe(WATCHLIST_LIST_CAP_UNSET);
  });
  it('refuses a symbol listed twice in one list, and a shape it does not know', () => {
    expect(codeOf(() => parseWatchlists([list(['BTC/USDT', 'BTC/USDT'])], caps))).toMatch(/preferences_value_invalid|invalid/i);
    expect(codeOf(() => parseWatchlists([{ ...list([]), colour: 'pink' }], caps))).not.toBeNull();
    expect(codeOf(() => parseWatchlists([list(['no slash'])], caps))).not.toBeNull();
  });
  it('lets a blank-cap account clear its lists (nothing to cap)', () => {
    expect(parseWatchlists([], { listCap: null, symbolCap: null, savedScreenCap: null })).toEqual([]);
  });
});

describe('saved screens (trade.screens)', () => {
  const screen = (id: string) => ({
    id,
    name: 'Momentum',
    filters: {
      quote: 'USDT',
      changeMin: '5',
      changeMax: null,
      volumeMin: null,
      lastMin: null,
      lastMax: null,
      universe: 'all',
      listId: null,
    },
    columns: ['last', 'change'],
    changeTimeframe: '24h',
  });
  it('keeps screens under the saved-screen cap and refuses one over it', () => {
    expect(parseSavedScreens([screen('a')], caps)).toHaveLength(1);
    expect(codeOf(() => parseSavedScreens([screen('a'), screen('b'), screen('c')], caps))).toBe(SAVED_SCREEN_CAP_EXCEEDED);
  });
  it('refuses a screen when the saved-screen cap is blank', () => {
    expect(codeOf(() => parseSavedScreens([screen('a')], { listCap: 1, symbolCap: 1, savedScreenCap: null }))).toBe(SAVED_SCREEN_CAP_UNSET);
  });
  it('refuses a filter bound that is not a decimal string, and an unknown timeframe', () => {
    const bad = { ...screen('a'), filters: { ...screen('a').filters, changeMin: 'five' } };
    expect(codeOf(() => parseSavedScreens([bad], caps))).not.toBeNull();
    expect(codeOf(() => parseSavedScreens([{ ...screen('a'), changeTimeframe: '7m' }], caps))).not.toBeNull();
  });
});

describe('caps apply to growth only, against the stored record', () => {
  const lowered = { listCap: 1, symbolCap: 1, savedScreenCap: 1 };
  const blank = { listCap: null, symbolCap: null, savedScreenCap: null };
  const stored = [list(['BTC/USDT', 'ETH/USDT', 'IFC/USDT'], 'majors'), list(['SOL/USDT'], 'alts')];
  const screen = (id: string) => ({
    id,
    name: id,
    filters: {
      quote: null,
      changeMin: null,
      changeMax: null,
      volumeMin: null,
      lastMin: null,
      lastMax: null,
      universe: 'all',
      listId: null,
    },
    columns: ['last'],
    changeTimeframe: '24h',
  });

  it('lets a delete pass when the stored record is over a cap that has since been lowered', () => {
    const afterDelete = [list(['BTC/USDT', 'ETH/USDT'], 'majors'), list(['SOL/USDT'], 'alts')];
    expect(parseWatchlists(afterDelete, lowered, stored)).toEqual(afterDelete);
  });

  it('lets a reorder pass when the record is over a lowered cap', () => {
    const reordered = [list(['SOL/USDT'], 'alts'), list(['BTC/USDT', 'ETH/USDT', 'IFC/USDT'], 'majors')];
    expect(parseWatchlists(reordered, lowered, stored)).toEqual(reordered);
  });

  it('refuses a symbol added past a lowered cap', () => {
    const grown = [list(['BTC/USDT', 'ETH/USDT', 'IFC/USDT', 'DOGE/USDT'], 'majors'), list(['SOL/USDT'], 'alts')];
    expect(codeOf(() => parseWatchlists(grown, lowered, stored))).toBe(WATCHLIST_CAP_EXCEEDED);
  });

  it('refuses a new list past a lowered list cap, and lets the same record stay as it is', () => {
    const more = [...stored, list(['DOGE/USDT'], 'meme')];
    expect(codeOf(() => parseWatchlists(more, lowered, stored))).toBe(WATCHLIST_CAP_EXCEEDED);
    expect(parseWatchlists(stored, lowered, stored)).toEqual(stored);
  });

  it('refuses growth when the cap is blank, and lets a delete through', () => {
    const grown = [list(['BTC/USDT'], 'majors'), list(['SOL/USDT'], 'alts'), list([], 'new')];
    expect(codeOf(() => parseWatchlists(grown, blank, stored))).toBe(WATCHLIST_LIST_CAP_UNSET);
    const deleted = [list(['BTC/USDT'], 'majors')];
    expect(parseWatchlists(deleted, blank, stored)).toEqual(deleted);
  });

  it('counts the symbols of a list new to the record from zero', () => {
    const fresh = [...stored, list(['DOGE/USDT'], 'meme')];
    expect(codeOf(() => parseWatchlists(fresh, { listCap: 10, symbolCap: null, savedScreenCap: null }, stored))).toBe(
      WATCHLIST_SYMBOL_CAP_UNSET,
    );
  });

  it('saved screens: a delete passes over a lowered cap, growth is refused', () => {
    const before = [screen('a'), screen('b'), screen('c')];
    expect(parseSavedScreens([screen('a')], lowered, before)).toHaveLength(1);
    expect(codeOf(() => parseSavedScreens([screen('a'), screen('b')], lowered, [screen('a')]))).toBe(SAVED_SCREEN_CAP_EXCEEDED);
    expect(codeOf(() => parseSavedScreens([screen('a'), screen('z')], blank, [screen('a')]))).toBe(SAVED_SCREEN_CAP_UNSET);
    expect(parseSavedScreens([screen('a')], blank, before)).toHaveLength(1);
  });
});
