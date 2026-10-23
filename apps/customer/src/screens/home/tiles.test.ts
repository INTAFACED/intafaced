import { describe, expect, it } from 'vitest';
import { HOME_TILE_IDS, canMove, isHidden, moved, orderedTiles, shownTiles, withHidden } from './tiles';

describe('Home tiles (HM-widgets-01)', () => {
  it('with nothing stored, every tile shows in the shipped order', () => {
    expect(orderedTiles(null)).toEqual(HOME_TILE_IDS);
    expect(shownTiles(null, 'pro')).toEqual(['started', 'work', 'holdings', 'activity', 'markets']);
    expect(shownTiles(null, 'simple', 'main')).toEqual(['work', 'holdings', 'markets', 'movers', 'activity', 'learn']);
    expect(shownTiles(null, 'simple', 'side')).toEqual(['started', 'your-crypto', 'watchlist']);
  });

  it('follows the stored order, puts each unnamed tile back after the tile it follows when shipped, and ignores an id this build does not know', () => {
    const layout = { order: ['activity', 'gone-tile', 'markets'], hidden: ['gone-tile'] };
    expect(orderedTiles(layout)).toEqual([
      'started',
      'work',
      'holdings',
      'activity',
      'learn',
      'your-crypto',
      'watchlist',
      'markets',
      'movers',
    ]);
    expect(shownTiles(layout, 'pro')).toEqual(['started', 'work', 'holdings', 'activity', 'markets']);
    expect(shownTiles(layout, 'simple', 'main')).toEqual(['work', 'holdings', 'activity', 'learn', 'markets', 'movers']);
  });

  it('a tile added after a layout was saved lands at its shipped place, not at the bottom', () => {
    const saved = { order: ['started', 'activity', 'holdings', 'markets', 'movers', 'learn', 'your-crypto', 'watchlist'], hidden: [] };
    expect(shownTiles(saved, 'simple', 'main')).toEqual(['work', 'activity', 'holdings', 'markets', 'movers', 'learn']);
    expect(shownTiles(saved, 'pro')).toEqual(['started', 'work', 'activity', 'holdings', 'markets']);
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
    expect(moved(null, 'markets', -1).order.slice(0, 4)).toEqual(['started', 'work', 'markets', 'holdings']);
    expect(moved(null, 'activity', -1, 'pro').order.slice(0, 4)).toEqual(['started', 'work', 'activity', 'holdings']);
    expect(moved(null, 'started', -1).order).toEqual([]);
    expect(moved(null, 'watchlist', 1).order).toEqual([]);
  });

  it('steps over the tiles this Home draws elsewhere, so a move always changes what is seen', () => {
    // Pro: Markets is the last tile Pro draws, so it cannot move down past the Simple-only tiles.
    expect(canMove(null, 'markets', 1, 'pro')).toBe(false);
    expect(moved(null, 'markets', 1, 'pro').order).toEqual([]);
    // Simple: Learn moves above Recent activity in the main column, never into the side column.
    expect(shownTiles(moved(null, 'learn', -1), 'simple', 'main')).toEqual(['work', 'holdings', 'markets', 'movers', 'learn', 'activity']);
    expect(canMove(null, 'started', 1)).toBe(true);
    expect(shownTiles(moved(null, 'started', 1), 'simple', 'side')).toEqual(['your-crypto', 'started', 'watchlist']);
    expect(canMove(null, 'watchlist', 1)).toBe(false);
  });
});
