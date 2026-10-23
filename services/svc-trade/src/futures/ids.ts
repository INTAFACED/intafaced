import { createHash } from 'node:crypto';

/**
 * Derived futures position ids (same shape as spot `orderIdFor`).
 *
 * §5 money paths: never `crypto.randomUUID()` for a retryable open. A timeout
 * + retry must find the original margin lock and position row, not lock a
 * second pot under a fresh id.
 *
 * Version nibble 8 = RFC 9562 custom (not random).
 */
function derive(namespace: string, name: string): string {
  const digest = createHash('sha256').update(namespace).update('').update(name).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Position id for a caller-supplied `clientOpenId`.
 * Scoped to (user, market) — client ids are per-caller namespace.
 */
export function positionIdFor(userId: string, marketId: string, clientOpenId: string): string {
  return derive('intafaced.trade.position', `${userId}:${marketId}:${clientOpenId}`);
}

/**
 * Futures order id for a caller's `clientOrderId` on one market (slice 6). The same retry always names the
 * same order, so the hold key `futures.order.margin.hold:<id>` posts once however often the request repeats.
 */
export function matchedOrderIdFor(userId: string, marketId: string, clientOrderId: string): string {
  return derive('intafaced.trade.futures-matched-order', `${userId}:${marketId}:${clientOrderId}`);
}

/**
 * Position id for a NEW position row opened by matched fills on one side of one market. The row is the
 * user's open slot `(user, market, side, isolated)`; `generation` counts the rows that slot has had, so a slot
 * that was closed gets a fresh id instead of colliding with its old row's primary key.
 */
export function matchedSlotPositionIdFor(userId: string, marketId: string, side: 'long' | 'short', generation: number): string {
  return derive('intafaced.trade.futures-matched-slot', `${userId}:${marketId}:${side}:${generation}`);
}
