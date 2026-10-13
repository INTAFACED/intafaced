import { beforeEach, describe, expect, it } from 'vitest';
import { cleanFavorites, favoritesKey, readFavorites, resetFavoritesCache, toggleFavorite, writeFavorites } from './favorites';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

beforeEach(() => resetFavoritesCache());

describe('favourites storage', () => {
  it('uses the same key as the existing trade screen so saved favourites survive', () => {
    expect(favoritesKey('user-1')).toBe('trade-favorites:user-1');
    expect(favoritesKey(null)).toBe('trade-favorites:guest');
    expect(favoritesKey(undefined)).toBe('trade-favorites:guest');
  });

  it('reads a list written by the old screen', () => {
    const storage = fakeStorage({ 'trade-favorites:user-1': JSON.stringify(['BTC/USDT', 'ETH/USDT']) });
    expect(readFavorites('user-1', storage)).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('writes the same JSON shape the old screen reads', () => {
    const storage = fakeStorage();
    writeFavorites('user-1', ['IFC/USDT'], storage);
    expect(storage.data.get('trade-favorites:user-1')).toBe('["IFC/USDT"]');
  });

  it('toggles a symbol on and off', () => {
    const storage = fakeStorage();
    expect(toggleFavorite('u', 'BTC/USDT', storage)).toEqual(['BTC/USDT']);
    expect(toggleFavorite('u', 'ETH/USDT', storage)).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(toggleFavorite('u', 'BTC/USDT', storage)).toEqual(['ETH/USDT']);
  });

  it('keeps users apart', () => {
    const storage = fakeStorage();
    writeFavorites('a', ['BTC/USDT'], storage);
    expect(readFavorites('b', storage)).toEqual([]);
  });

  it('ignores junk in storage', () => {
    expect(readFavorites('u', fakeStorage({ 'trade-favorites:u': 'not json' }))).toEqual([]);
    expect(readFavorites('u', fakeStorage({ 'trade-favorites:u': '{"a":1}' }))).toEqual([]);
    expect(cleanFavorites(['BTC/USDT', 3, null, ' ', 'BTC/USDT', ' ETH/USDT '])).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('survives storage that throws, keeping the list for the tab', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    writeFavorites('u', ['BTC/USDT'], broken);
    expect(readFavorites('u', broken)).toEqual(['BTC/USDT']);
    expect(readFavorites('u', null)).toEqual(['BTC/USDT']);
  });
});
