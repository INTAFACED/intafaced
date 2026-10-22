/**
 * Which consumer settles a matching fill (futures ADR slice 6): the orders decide, not the market's kind.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EventBus } from '@intafaced/events';
import type { TradeService } from './spot/trade-service.js';
import { subscribeMatchingEvents, type MatchedFillsSink } from './events.js';

type Handler = (payload: unknown, envelope: { subject: string; idempotencyKey: string }) => Promise<void>;

async function wire(ownsFill: MatchedFillsSink['ownsFill']) {
  const handlers = new Map<string, Handler>();
  const bus = {
    subscribe: async (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return { unsubscribe: async () => undefined };
    },
  } as unknown as EventBus;
  const trade = { settleFillEvent: vi.fn(async () => undefined), releaseOnCancelEvent: vi.fn(async () => undefined) };
  const sink = {
    ownsFill: vi.fn(ownsFill),
    settle: vi.fn(async () => undefined),
    releaseCancelled: vi.fn(async () => false),
  };
  await subscribeMatchingEvents(bus, trade as unknown as TradeService, undefined, { current: sink });
  const fill = {
    marketId: 'futures-market',
    makerOrderId: 'maker',
    takerOrderId: 'taker',
    price: '100',
    qty: '1',
    sequence: 9,
    makerAccountId: 'm',
    takerAccountId: 't',
  };
  return { deliver: () => handlers.get('orderFilled')!(fill, { subject: 'orderFilled', idempotencyKey: 'fill:9' }), trade, sink };
}

describe('matching fill routing', () => {
  it('a fill between two matched futures orders settles in the futures book', async () => {
    const { deliver, trade, sink } = await wire(async () => true);
    await deliver();
    expect(sink.settle).toHaveBeenCalledTimes(1);
    expect(trade.settleFillEvent).not.toHaveBeenCalled();
  });

  it('a fill between orders the spot path placed goes to the spot path, even on a futures market', async () => {
    const { deliver, trade, sink } = await wire(async () => false);
    await deliver();
    expect(trade.settleFillEvent).toHaveBeenCalledTimes(1);
    expect(sink.settle).not.toHaveBeenCalled();
  });

  it('a fill the futures book refuses to own is not handed to the spot path', async () => {
    const { deliver, trade } = await wire(async () => {
      throw Object.assign(new Error('crosses order paths'), { code: 'trade.futures_fill_crosses_order_paths' });
    });
    await expect(deliver()).rejects.toMatchObject({ code: 'trade.futures_fill_crosses_order_paths' });
    expect(trade.settleFillEvent).not.toHaveBeenCalled();
  });
});
