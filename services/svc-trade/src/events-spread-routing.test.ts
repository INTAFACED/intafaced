/**
 * Spread fills and cancellations (CB-otc-16): a spread fill has its own subject and is settled only by the spread
 * service; a cancellation reaches the spread service before the spot path; a fill that arrives before the service is
 * wired is not acknowledged.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EventBus } from '@intafaced/events';
import type { TradeService } from './spot/trade-service.js';
import { subscribeMatchingEvents, type SpreadFillsSink } from './events.js';

type Handler = (payload: unknown, envelope: { subject: string; idempotencyKey: string }) => Promise<void>;

async function wire(sink: SpreadFillsSink | null, options: { futuresTakesCancel?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const bus = {
    subscribe: async (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return { unsubscribe: async () => undefined };
    },
  } as unknown as EventBus;
  const trade = { settleFillEvent: vi.fn(async () => undefined), releaseOnCancelEvent: vi.fn(async () => undefined) };
  const futures = {
    ownsFill: vi.fn(async () => false),
    settle: vi.fn(async () => undefined),
    releaseCancelled: vi.fn(async () => options.futuresTakesCancel ?? false),
  };
  const subscriptions = await subscribeMatchingEvents(
    bus,
    trade as unknown as TradeService,
    undefined,
    { current: futures },
    { current: sink },
  );
  return { handlers, trade, futures, subscriptions };
}

const spreadFill = {
  spreadId: 'CAL',
  makerOrderId: 'maker',
  takerOrderId: 'taker',
  makerAccountId: 'm',
  takerAccountId: 't',
  takerSide: 'sell',
  price: '-5',
  qty: '2',
  sequence: 4,
  ts: '2026-10-20T12:00:00.000Z',
  legs: [
    { symbol: 'far', takerSide: 'sell', qty: '2', price: '105' },
    { symbol: 'near', takerSide: 'buy', qty: '2', price: '110' },
  ],
};

describe('spread event routing', () => {
  it('subscribes to the spread subject on its own durable', async () => {
    const { subscriptions } = await wire(null);
    expect(subscriptions).toHaveLength(3);
  });

  it('a spread fill goes to the spread service, with both legs and a signed price, and never to the spot or outright path', async () => {
    const sink = { settle: vi.fn(async () => undefined), releaseCancelled: vi.fn(async () => false) };
    const { handlers, trade, futures } = await wire(sink);
    await handlers.get('spreadFilled')!(spreadFill, { subject: 'spreadFilled', idempotencyKey: 'matching.spread.filled:CAL:4' });
    expect(sink.settle).toHaveBeenCalledTimes(1);
    expect(sink.settle).toHaveBeenCalledWith({
      spreadId: 'CAL',
      makerOrderId: 'maker',
      takerOrderId: 'taker',
      takerSide: 'sell',
      price: '-5',
      qty: '2',
      sequence: 4,
      legs: spreadFill.legs,
    });
    expect(trade.settleFillEvent).not.toHaveBeenCalled();
    expect(futures.settle).not.toHaveBeenCalled();
  });

  it('a spread fill that arrives before the service is wired is refused, so the bus redelivers it', async () => {
    const { handlers } = await wire(null);
    await expect(
      handlers.get('spreadFilled')!(spreadFill, { subject: 'spreadFilled', idempotencyKey: 'matching.spread.filled:CAL:4' }),
    ).rejects.toThrow(/redelivered/);
  });

  it('a fill the spread service refuses is thrown, not swallowed', async () => {
    const sink = {
      settle: vi.fn(async () => {
        throw Object.assign(new Error('outside cover'), { code: 'trade.spread_fill_outside_cover' });
      }),
      releaseCancelled: vi.fn(async () => false),
    };
    const { handlers } = await wire(sink);
    await expect(
      handlers.get('spreadFilled')!(spreadFill, { subject: 'spreadFilled', idempotencyKey: 'matching.spread.filled:CAL:4' }),
    ).rejects.toMatchObject({ code: 'trade.spread_fill_outside_cover' });
  });

  it('a cancellation of a spread order releases its hold there and does not reach the spot path', async () => {
    const sink = { settle: vi.fn(async () => undefined), releaseCancelled: vi.fn(async () => true) };
    const { handlers, trade, futures } = await wire(sink);
    await handlers.get('orderCancelled')!(
      { orderId: 'o1', marketId: 'CAL', accountId: 'a', remainingQty: '1', sequence: 3, reason: 'cancel', ts: '2026-10-20T12:00:00.000Z' },
      { subject: 'orderCancelled', idempotencyKey: 'c:3' },
    );
    expect(futures.releaseCancelled).toHaveBeenCalledWith('o1', '1');
    expect(sink.releaseCancelled).toHaveBeenCalledWith('o1', '1');
    expect(trade.releaseOnCancelEvent).not.toHaveBeenCalled();
  });

  it('a cancellation that is neither an outright futures nor a spread order is left to the spot path', async () => {
    const sink = { settle: vi.fn(async () => undefined), releaseCancelled: vi.fn(async () => false) };
    const { handlers, trade } = await wire(sink);
    await handlers.get('orderCancelled')!(
      { orderId: 'o2', marketId: 'm', accountId: 'a', remainingQty: '1', sequence: 3, reason: 'cancel', ts: '2026-10-20T12:00:00.000Z' },
      { subject: 'orderCancelled', idempotencyKey: 'c:4' },
    );
    expect(trade.releaseOnCancelEvent).toHaveBeenCalledWith('o2');
  });

  it('an outright futures cancellation never reaches the spread service', async () => {
    const sink = { settle: vi.fn(async () => undefined), releaseCancelled: vi.fn(async () => true) };
    const { handlers } = await wire(sink, { futuresTakesCancel: true });
    await handlers.get('orderCancelled')!(
      { orderId: 'o3', marketId: 'm', accountId: 'a', remainingQty: '1', sequence: 3, reason: 'cancel', ts: '2026-10-20T12:00:00.000Z' },
      { subject: 'orderCancelled', idempotencyKey: 'c:5' },
    );
    expect(sink.releaseCancelled).not.toHaveBeenCalled();
  });
});
