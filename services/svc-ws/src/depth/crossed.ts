import { bookFromSnapshot, bookTop, type DepthBook, type DepthSnapshot } from '@intafaced/market-data';

/**
 * A house book is crossed when the best bid is at or above the best ask.
 * One-sided books are not crossed. Callers withhold a crossed copy instead of
 * offering it as a live top.
 */
export function bookIsCrossed(book: DepthBook): boolean {
  const top = bookTop(book);
  return top.bestBid !== null && top.bestAsk !== null && top.bestBid >= top.bestAsk;
}

export function snapshotIsCrossed(snapshot: DepthSnapshot): boolean {
  return bookIsCrossed(bookFromSnapshot(snapshot));
}
