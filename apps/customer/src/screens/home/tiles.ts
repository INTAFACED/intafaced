import type { HomeTilesValue } from '@intafaced/contracts/home-tiles-preferences';

/**
 * Home's tiles (HM-widgets-01): one list for Simple and Pro. Each tile has an id the account's `home.tiles` record names,
 * the column it sits in on Simple Home, and whether Pro Home draws it. The total at the top is not a tile: it always shows.
 * Hiding a tile is a view choice only; no room, route or control goes away, and every tile stays in the list of choices
 * whatever the mode.
 */
export const HOME_TILES = [
  { id: 'started', column: 'side', pro: true },
  { id: 'holdings', column: 'main', pro: true },
  { id: 'markets', column: 'main', pro: true },
  { id: 'movers', column: 'main', pro: false },
  { id: 'activity', column: 'main', pro: true },
  { id: 'learn', column: 'main', pro: false },
  { id: 'your-crypto', column: 'side', pro: false },
  { id: 'watchlist', column: 'side', pro: false },
] as const;
export type HomeTileId = (typeof HOME_TILES)[number]['id'];
export const HOME_TILE_IDS: readonly HomeTileId[] = HOME_TILES.map((tile) => tile.id);

const known = (id: string): id is HomeTileId => (HOME_TILE_IDS as readonly string[]).includes(id);

/**
 * The shipped order of each Home: the list above for Simple; Pro keeps its activity above its markets panel. The owner's
 * default set is not set yet, so with nothing stored every tile shows in its Home's shipped order.
 */
const SHIPPED: Record<'simple' | 'pro', readonly HomeTileId[]> = {
  simple: HOME_TILE_IDS,
  pro: ['started', 'holdings', 'activity', 'markets', 'movers', 'learn', 'your-crypto', 'watchlist'],
};

/**
 * Every tile, in the person's order, each once: the ids the record names first (an id this build does not know is
 * ignored), then any tile it does not name, in the shipped order. One stored order applies to both Homes.
 */
export function orderedTiles(layout: HomeTilesValue | null, mode: 'simple' | 'pro' = 'simple'): HomeTileId[] {
  const named = (layout?.order ?? []).filter(known);
  const seen = new Set<HomeTileId>(named);
  return [...named, ...SHIPPED[mode].filter((id) => !seen.has(id))];
}

/** Whether a tile is hidden. */
export function isHidden(layout: HomeTilesValue | null, id: HomeTileId): boolean {
  return (layout?.hidden ?? []).includes(id);
}

/** The tiles to draw, in order: not hidden, and drawn by this mode (and column, on Simple Home). */
export function shownTiles(layout: HomeTilesValue | null, mode: 'simple' | 'pro', column?: 'main' | 'side'): HomeTileId[] {
  return orderedTiles(layout, mode).filter((id) => {
    const tile = HOME_TILES.find((entry) => entry.id === id);
    if (!tile || isHidden(layout, id)) return false;
    return mode === 'pro' ? tile.pro : column === undefined || tile.column === column;
  });
}

/** The record after showing or hiding one tile. Ids this build does not know are kept as they were. */
export function withHidden(layout: HomeTilesValue | null, id: HomeTileId, hidden: boolean): HomeTilesValue {
  const rest = (layout?.hidden ?? []).filter((entry) => entry !== id);
  return { order: layout?.order ?? [], hidden: hidden ? [...rest, id] : rest };
}

/**
 * Whether two tiles are drawn in the same place on this Home: both drawn by Pro on Pro Home, else the same Simple column.
 * A move steps over the tiles drawn elsewhere, so every press changes what the person sees.
 */
function samePlace(a: HomeTileId, b: HomeTileId, mode: 'simple' | 'pro'): boolean {
  const first = HOME_TILES.find((tile) => tile.id === a);
  const second = HOME_TILES.find((tile) => tile.id === b);
  if (!first || !second) return false;
  return mode === 'pro' && first.pro ? second.pro : first.column === second.column;
}

/** Where `id` would land moving one place up (-1) or down (+1) among the tiles drawn with it, or -1 at either end. */
function target(order: readonly HomeTileId[], id: HomeTileId, step: -1 | 1, mode: 'simple' | 'pro'): number {
  for (let at = order.indexOf(id) + step; at >= 0 && at < order.length; at += step) {
    if (samePlace(id, order[at] as HomeTileId, mode)) return at;
  }
  return -1;
}

/** Whether a tile can move up (-1) or down (+1) on this Home. */
export function canMove(layout: HomeTilesValue | null, id: HomeTileId, step: -1 | 1, mode: 'simple' | 'pro' = 'simple'): boolean {
  return target(orderedTiles(layout, mode), id, step, mode) >= 0;
}

/**
 * The record after moving one tile a place up (-1) or down (+1) among the tiles drawn with it. The record holds one order
 * for both Homes, so it is stored in full.
 */
export function moved(layout: HomeTilesValue | null, id: HomeTileId, step: -1 | 1, mode: 'simple' | 'pro' = 'simple'): HomeTilesValue {
  const order = orderedTiles(layout, mode);
  const at = order.indexOf(id);
  const to = target(order, id, step, mode);
  if (at < 0 || to < 0) return { order: layout?.order ?? [], hidden: layout?.hidden ?? [] };
  [order[at], order[to]] = [order[to] as HomeTileId, order[at] as HomeTileId];
  return { order, hidden: layout?.hidden ?? [] };
}
