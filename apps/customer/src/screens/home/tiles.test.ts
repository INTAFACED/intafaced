import { describe, expect, it } from 'vitest';
import { HOME_TILE_IDS, isHidden, moved, orderedTiles, shownTiles, withHidden } from './tiles';

describe('Home tiles (HM-widgets-01)', () => {
  it('with nothing stored, every tile shows in the shipped order', () => {
    expect(orderedTiles(null)).toEqual(HOME_TILE_IDS);
    expect(shownTiles(null, 'pro')).toEqual(['started', 'holdings', 'activity', 'markets']);
    expect(shownTiles(null, 'simple', 'main')).toEqual(['holdings', 'markets', 'movers', 'activity', 'learn']);
    expect(shownTiles(null, 'simple', 'side')).toEqual(['started', 'your-crypto', 'watchlist']);
  });

  it('follows the stored order, puts unnamed tiles after it, and ignores an id this build does not know', () => {
    const layout = { order: ['markets', 'gone-tile', 'activity'], hidden: ['gone-tile'] };
    expect(orderedTiles(layout).slice(0, 2)).toEqual(['markets', 'activity']);
    expect(orderedTiles(layout)).toHaveLength(HOME_TILE_IDS.length);
    expect(shownTiles(layout, 'pro')).toEqual(['markets', 'activity', 'started', 'holdings']);
    expect(shownTiles(layout, 'simple', 'main')).toEqual(['markets', 'activity', 'holdings', 'movers', 'learn']);
  });

  it('a hidden tile is not drawn in either mode and stays in the list of choices', () => {
    const layout = withHidden(null, 'markets', true);
    expect(isHidden(layout, 'markets')).toBe(true);
    expect(shownTiles(layout, 'pro')).not.toContain('markets');
    expect(shownTiles(layout, 'simple', 'main')).not.toContain('markets');
    expect(orderedTiles(layout)).toContain('markets');
    expect(withHidden(layout, 'markets', false).hidden).toEqual([]);
  });

  it('keeps ids it does not know when it changes the record', () => {
    const layout = { order: ['future-tile'], hidden: ['future-tile'] };
    expect(withHidden(layout, 'markets', true)).toEqual({ order: ['future-tile'], hidden: ['future-tile', 'markets'] });
  });

  it('moves a tile one place, and not past either end', () => {
    expect(moved(null, 'markets', -1).order.slice(0, 3)).toEqual(['started', 'markets', 'holdings']);
    expect(moved(null, 'activity', -1, 'pro').order.slice(0, 3)).toEqual(['started', 'activity', 'holdings']);
    expect(moved(null, 'started', -1).order).toEqual([]);
    expect(moved(null, 'watchlist', 1).order).toEqual([]);
  });
});
