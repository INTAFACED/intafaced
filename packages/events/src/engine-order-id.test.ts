import { describe, expect, it } from 'vitest';
import { orderAccepted, orderCancelled, orderFilled, engineOrderIdSchema } from './catalog.js';

const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const filled = (maker: string, taker: string) => ({
  marketId: 'btc-usdt',
  makerOrderId: maker,
  takerOrderId: taker,
  price: '110',
  qty: '0.4',
  sequence: 7,
  ts: '2026-10-19T09:00:00.000Z',
});

describe('engine order ids on the bus: an order uuid or one OCO leg of it', () => {
  it('accepts an order uuid and its :tp / :sl legs', () => {
    expect(engineOrderIdSchema.safeParse(ID).success).toBe(true);
    expect(engineOrderIdSchema.safeParse(`${ID}:tp`).success).toBe(true);
    expect(engineOrderIdSchema.safeParse(`${ID}:sl`).success).toBe(true);
  });

  it('refuses anything else', () => {
    for (const bad of ['', 'not-a-uuid', `${ID}:`, `${ID}:xx`, `${ID}:tp:tp`, `:tp`, `${ID} :tp`, `${ID}\n:tp`]) {
      expect(engineOrderIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('matching.order.filled carries a leg as the maker or the taker', () => {
    expect(orderFilled.schema.safeParse(filled(`${ID}:tp`, OTHER)).success).toBe(true);
    expect(orderFilled.schema.safeParse(filled(OTHER, `${ID}:sl`)).success).toBe(true);
    expect(orderFilled.schema.safeParse(filled('nope', OTHER)).success).toBe(false);
  });

  it('matching.order.cancelled and accepted carry a leg', () => {
    expect(orderCancelled.schema.safeParse({ orderId: `${ID}:sl`, marketId: 'btc-usdt', remainingQty: '0.6', sequence: 8 }).success).toBe(
      true,
    );
    expect(orderAccepted.schema.safeParse({ orderId: `${ID}:tp`, marketId: 'btc-usdt', sequence: 1 }).success).toBe(true);
  });

  it('matching.order.cancelled may say why the order left, and an older event without the reason still parses', () => {
    const base = { orderId: ID, marketId: 'btc-usdt', remainingQty: '0.6', sequence: 9 };
    expect(orderCancelled.schema.parse({ ...base, reason: 'expired' }).reason).toBe('expired');
    expect(orderCancelled.schema.parse(base).reason).toBeUndefined();
    expect(orderCancelled.schema.safeParse({ ...base, reason: '' }).success).toBe(false);
  });
});
