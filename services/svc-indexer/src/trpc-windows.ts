/**
 * Owner-published tRPC book and list windows. Blank / non-integer / out of cap
 * refuses. Never invent 50.
 *
 * The cap stays a cap (200) — never a default. Positions reuse the book's
 * 1..200 window.
 */
export const INDEXER_BOOK_DEPTH_UNSET = 'indexer.book_depth_unset' as const;
export const INDEXER_POSITIONS_LIST_LIMIT_UNSET = 'indexer.positions_list_limit_unset' as const;

export const INDEXER_BOOK_DEPTH_MAX = 200;

export function isPublishedBookDepth(depth: number | undefined | null): depth is number {
  return typeof depth === 'number' && Number.isInteger(depth) && depth >= 1 && depth <= INDEXER_BOOK_DEPTH_MAX;
}
