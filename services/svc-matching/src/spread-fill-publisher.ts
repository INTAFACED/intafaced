/**
 * Spread fills go out on `matching.spread.filled` (CB-otc-16, `spreadFilled` in packages/events). Not `order.filled`:
 * a spread print has a signed price and two legs, and svc-trade settles it through its spread door, never as an
 * outright trade. The engine calls this with the journal key `matching.spread.filled:<spreadId>:<sequence>` as the
 * idempotency key, so a replay after a crash republishes the same envelope id and the consumer settles it once.
 */
import type { EventBus } from '@intafaced/events';
import type { SpreadFillPublisher } from './engine/spread-book.js';

export function spreadFillPublisherFor(bus: EventBus): SpreadFillPublisher {
  return {
    publish: (event, opts) => bus.publish('spreadFilled', { ...event, legs: [...event.legs] }, opts),
  };
}
