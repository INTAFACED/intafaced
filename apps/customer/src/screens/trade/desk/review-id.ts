/**
 * The order number of a reviewed draft.
 *
 * A draft gets its number once, when it is first reviewed, and keeps it while it is the same order: reviewing the
 * same form again (after a closed ticket, a refreshed preview, an uncertain send; the saved marker covers a page reload) gives back the same number, so
 * the trade service, which keeps one order per (user, market, number), can never place it twice. Any change to the
 * order is a different draft with a new number. Once an outcome is known the number is dropped, so a later order that
 * happens to look the same is a new order and not a replay of the old one.
 *
 * Shape: `desk:<userId>:<draft hash>-<mint>`. The hash names the draft for a person reading logs; the mint keeps two
 * separate orders of the same size apart.
 */
import type { Draft } from '../../../features/trade/trade-api';

type Unnumbered = Omit<Draft, 'clientOrderId'>;

const minted = new Map<string, string>();

/** FNV-1a over the draft body, 32 bits in hex. A label, not a key: the map is keyed by the full body. */
function hashOf(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The order itself: the tag is the person's label, never part of the order's identity (the service keys without it). */
const bodyOf = ({ tag: _tag, ...draft }: Unnumbered): string => JSON.stringify(draft);

/** The number for this draft: the one already given to the same draft, or a new one. */
export function reviewIdFor(userId: string, draft: Unnumbered, mint: () => string = () => crypto.randomUUID().slice(0, 8)): string {
  const body = bodyOf(draft);
  const key = `${userId}\n${body}`;
  const known = minted.get(key);
  if (known) return known;
  const id = `desk:${userId}:${hashOf(body)}-${mint()}`;
  minted.set(key, id);
  return id;
}

/** The outcome of this number is known (placed, refused, not sent): the next identical draft is a new order. */
export function forgetReviewId(id: string): void {
  for (const [key, value] of minted) if (value === id) minted.delete(key);
}

/** For tests. */
export function resetReviewIds(): void {
  minted.clear();
}
