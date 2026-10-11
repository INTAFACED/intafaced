import { describe, expect, it } from 'vitest';
import { ORDERS_ENGINE_UNAVAILABLE, PrivateOrderHub, type PrivateOrderUpdate, type PrivatePositionUpdate } from './hub.js';

function sink() {
  const sent: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  return {
    sent,
    get bufferedBytes() {
      return 0;
    },
    send(frame: string) {
      sent.push(frame);
    },
    close(code: number, reason: string) {
      closed = { code, reason };
    },
    get closed() {
      return closed;
    },
  };
}

const update = (userId: string, orderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'): PrivateOrderUpdate => ({
  orderId,
  userId,
  marketId: 'btc-usdt',
  status: 'open',
  side: 'buy',
  type: 'limit',
  qty: '1',
  filledQty: '0',
  price: '100',
  clientOrderId: null,
  ts: '2026-07-30T00:00:00.000Z',
});

const position = (userId: string, positionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'): PrivatePositionUpdate => ({
  positionId,
  userId,
  marketId: 'btc-usdt-perp',
  symbol: 'BTC/USDT:USDT',
  status: 'open',
  side: 'long',
  contracts: '2',
  entryPrice: '60000',
  markPrice: '60100',
  notional: '120200',
  leverage: '10',
  collateral: '12020',
  unrealizedPnl: '200',
  realizedPnl: '0',
  liquidationPrice: '54000',
  marginMode: 'cross',
  fundingPaid: '0',
  ts: '2026-07-31T00:00:00.000Z',
});

describe('PrivateOrderHub', () => {
  it('fans an update only to the owning user', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const alice = sink();
    const bob = sink();
    hub.attach('user-a', alice);
    hub.attach('user-b', bob);

    hub.publish(update('user-a'));

    expect(alice.sent).toHaveLength(1);
    expect(JSON.parse(alice.sent[0]!).userId).toBe('user-a');
    expect(JSON.parse(alice.sent[0]!).fact).toBe('ack');
    expect(bob.sent).toHaveLength(0);
  });

  it('fans fills only to the owning user on channel fills', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const alice = sink();
    const bob = sink();
    hub.attach('user-a', alice);
    hub.attach('user-b', bob);
    hub.publishFill({
      fillId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'user-a',
      marketId: 'btc-usdt',
      side: 'buy',
      liquidity: 'taker',
      price: '100',
      qty: '1',
      quoteAmount: '100',
      feeAsset: 'USDT',
      feeAmount: '0.1',
      feeBps: 10,
      sequence: 1,
      ts: '2026-07-30T00:00:00.000Z',
    });
    expect(alice.sent).toHaveLength(1);
    expect(JSON.parse(alice.sent[0]!).channel).toBe('fills');
    expect(JSON.parse(alice.sent[0]!).fact).toBe('fill');
    expect(bob.sent).toHaveLength(0);
  });

  it('emits ack, reject, fill, cancel as distinct facts — unknown is not ack', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const alice = sink();
    hub.attach('user-a', alice);

    hub.publish({ ...update('user-a'), status: 'open' });
    hub.publish({ ...update('user-a', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), status: 'rejected' });
    hub.publish({ ...update('user-a', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'), status: 'filled' });
    hub.publish({ ...update('user-a', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'), status: 'cancelled' });
    hub.publish({ ...update('user-a', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), status: 'success' });

    const facts = alice.sent.map((s) => JSON.parse(s).fact);
    expect(facts).toEqual(['ack', 'reject', 'fill', 'cancel', 'unknown']);
    expect(new Set(facts.slice(0, 4)).size).toBe(4);
    expect(facts[4]).not.toBe('ack');
    expect(JSON.parse(alice.sent[4]!).status).toBe('success');
  });

  it('refuses attach when at capacity (null detach — no subscription)', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 1, maxConnectionsPerUser: 1 });
    const first = sink();
    const second = sink();
    const d1 = hub.attach('user-a', first);
    const d2 = hub.attach('user-b', second);
    expect(d1).not.toBeNull();
    expect(d2).toBeNull();
    expect(second.closed?.code).toBe(1013);
    expect(hub.connections).toBe(1);
  });

  it('refuses a user past per-user cap while another user still attaches', () => {
    const hub = new PrivateOrderHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 100,
      maxConnectionsPerUser: 2,
    });
    const a1 = sink();
    const a2 = sink();
    const a3 = sink();
    const b1 = sink();
    expect(hub.attach('user-a', a1)).not.toBeNull();
    expect(hub.attach('user-a', a2)).not.toBeNull();
    expect(hub.attach('user-a', a3)).toBeNull();
    expect(a3.closed?.code).toBe(1013);
    expect(a3.closed?.reason).toBe('ws.close.private_user_limit');
    expect(hub.connections).toBe(2);

    expect(hub.attach('user-b', b1)).not.toBeNull();
    expect(hub.connections).toBe(3);
  });

  it('reconnect after detach gets no replay of past orders (push-only)', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const first = sink();
    const detach = hub.attach('user-a', first);
    hub.publish(update('user-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    expect(first.sent).toHaveLength(1);
    detach!();

    const second = sink();
    hub.attach('user-a', second);
    expect(second.sent).toHaveLength(0);

    hub.publish(update('user-a', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    expect(second.sent).toHaveLength(1);
    expect(JSON.parse(second.sent[0]!).orderId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('evicts a lagging order subscriber without inventing fills', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 10, maxLagTicks: 2, maxConnections: 10, maxConnectionsPerUser: 10 });
    const lagging = {
      sent: [] as string[],
      get bufferedBytes() {
        return 100;
      },
      send() {
        throw new Error('should not send while lagging');
      },
      closed: null as { code: number; reason: string } | null,
      close(code: number, reason: string) {
        this.closed = { code, reason };
      },
    };
    hub.attach('user-a', lagging);
    hub.publish(update('user-a'));
    hub.publish(update('user-a'));
    expect(lagging.closed?.code).toBe(1013);
    expect(lagging.closed?.reason).toMatch(/slow consumer/i);
    expect(lagging.sent).toHaveLength(0);
  });

  it('evicts a quiet lagging seat without any publish (heartbeat sweep path)', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 10, maxLagTicks: 2, maxConnections: 10, maxConnectionsPerUser: 10 });
    const lagging = {
      sent: [] as string[],
      get bufferedBytes() {
        return 100;
      },
      send() {
        throw new Error('should not send');
      },
      closed: null as { code: number; reason: string } | null,
      close(code: number, reason: string) {
        this.closed = { code, reason };
      },
    };
    expect(hub.attach('user-a', lagging)).not.toBeNull();
    expect(hub.connections).toBe(1);
    // No publish — only quiet sweeps (gateway heartbeat).
    hub.sweepLag();
    expect(lagging.closed).toBeNull();
    hub.sweepLag();
    expect(lagging.closed?.code).toBe(1013);
    expect(hub.connections).toBe(0);
  });

  it('fans positions only to the owning user on channel positions', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const alice = sink();
    const bob = sink();
    hub.attach('user-a', alice);
    hub.attach('user-b', bob);

    const position: PrivatePositionUpdate = {
      positionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      userId: 'user-a',
      marketId: 'btc-usdt-perp',
      symbol: 'BTC/USDT:USDT',
      status: 'open',
      side: 'long',
      contracts: '2',
      entryPrice: '60000',
      markPrice: '60100',
      notional: '120200',
      leverage: '10',
      collateral: '12020',
      unrealizedPnl: '200',
      realizedPnl: '0',
      liquidationPrice: '54000',
      marginMode: 'cross',
      fundingPaid: '0',
      ts: '2026-07-31T00:00:00.000Z',
    };
    hub.publishPosition(position);

    expect(alice.sent).toHaveLength(1);
    const frame = JSON.parse(alice.sent[0]!);
    expect(frame.channel).toBe('positions');
    expect(frame.side).toBe('long');
    expect(frame.contracts).toBe('2');
    expect(bob.sent).toHaveLength(0);
  });

  it('evicts a lagging positions subscriber without touching a healthy peer', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 10, maxLagTicks: 2, maxConnections: 10, maxConnectionsPerUser: 10 });
    const lagging = {
      sent: [] as string[],
      get bufferedBytes() {
        return 100;
      },
      send() {
        throw new Error('should not send while lagging');
      },
      closed: null as { code: number; reason: string } | null,
      close(code: number, reason: string) {
        this.closed = { code, reason };
      },
    };
    const healthy = sink();
    hub.attach('user-a', lagging);
    hub.attach('user-a', healthy);

    const position: PrivatePositionUpdate = {
      positionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      userId: 'user-a',
      marketId: 'btc-usdt-perp',
      symbol: 'BTC/USDT:USDT',
      status: 'open',
      side: 'short',
      contracts: '1',
      entryPrice: '1',
      markPrice: '1',
      notional: '1',
      leverage: '1',
      collateral: '1',
      unrealizedPnl: '0',
      realizedPnl: '0',
      liquidationPrice: null,
      marginMode: 'isolated',
      fundingPaid: '0',
      ts: '2026-07-31T00:00:00.000Z',
    };
    hub.publishPosition(position);
    hub.publishPosition(position);

    expect(lagging.closed?.code).toBe(1013);
    expect(lagging.closed?.reason).toMatch(/slow consumer/i);
    expect(healthy.sent).toHaveLength(2);
    expect(JSON.parse(healthy.sent[0]!).channel).toBe('positions');
  });

  it('re-announces ready+bus to every live seat when private half attaches late', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const alice = sink();
    const bob = sink();
    hub.attach('user-a', alice);
    hub.attach('user-b', bob);

    hub.announceBus(true);

    expect(alice.sent).toHaveLength(3);
    expect(bob.sent).toHaveLength(3);
    expect(alice.sent.map((s) => JSON.parse(s).channel)).toEqual(['orders', 'fills', 'positions']);
    for (const raw of alice.sent) {
      const frame = JSON.parse(raw);
      expect(frame.type).toBe('ready');
      expect(frame.bus).toBe(true);
      expect(frame.userId).toBe('user-a');
    }
    for (const raw of bob.sent) {
      expect(JSON.parse(raw).userId).toBe('user-b');
    }
    // Honesty only — no invented order/fill/position payload.
    expect(alice.sent.some((s) => 'orderId' in JSON.parse(s))).toBe(false);
  });

  it('does not announce to a detached seat', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const alice = sink();
    const detach = hub.attach('user-a', alice);
    detach!();
    hub.announceBus(true);
    expect(alice.sent).toHaveLength(0);
  });

  it('re-announces ready only on the subscribed channel when attach is filtered', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const ordersOnly = sink();
    hub.attach('user-a', ordersOnly, 'orders');
    hub.announceBus(true);
    expect(ordersOnly.sent).toHaveLength(1);
    expect(JSON.parse(ordersOnly.sent[0]!).channel).toBe('orders');
    expect(JSON.parse(ordersOnly.sent[0]!).bus).toBe(true);
  });

  it('holds live frames until releaseSnapshot so snapshot stays first', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const alice = sink();
    hub.attach('user-a', alice, null, { holdUntilSnapshot: true });
    hub.publish(update('user-a'));
    expect(alice.sent).toHaveLength(0);
    hub.sendOrdersSnapshot(alice, 'user-a', []);
    hub.releaseSnapshot(alice);
    expect(JSON.parse(alice.sent[0]!).type).toBe('snapshot');
    expect(JSON.parse(alice.sent[1]!).orderId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('names orders.engine_unavailable once per down-edge, not a blank blotter', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const alice = sink();
    const bob = sink();
    hub.attach('user-a', alice);
    hub.attach('user-b', bob);

    hub.markEngineUnavailable();
    hub.markEngineUnavailable();

    expect(hub.engineCode).toBe(ORDERS_ENGINE_UNAVAILABLE);
    expect(alice.sent).toHaveLength(1);
    expect(JSON.parse(alice.sent[0]!)).toEqual({
      type: 'status',
      code: ORDERS_ENGINE_UNAVAILABLE,
      channel: 'orders',
      userId: 'user-a',
    });
    expect(JSON.parse(bob.sent[0]!).userId).toBe('user-b');
  });

  it('discloses engine-down to a seat that attaches after matching is already down', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    hub.markEngineUnavailable();
    const alice = sink();
    hub.attach('user-a', alice);
    expect(JSON.parse(alice.sent[0]!)).toMatchObject({ type: 'status', code: ORDERS_ENGINE_UNAVAILABLE, channel: 'orders' });
  });

  it('does not send engine-unavailable onto a positions-only seat', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const positions = sink();
    hub.attach('user-a', positions, 'positions');
    hub.markEngineUnavailable();
    expect(positions.sent).toEqual([]);
    expect(hub.isEngineUnavailable).toBe(true);
  });

  it('queues engine-unavailable behind holdUntilSnapshot so ready/snapshot stay first', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const alice = sink();
    hub.attach('user-a', alice, 'orders', { holdUntilSnapshot: true });
    hub.markEngineUnavailable();
    expect(alice.sent).toHaveLength(0);
    hub.releaseSnapshot(alice);
    expect(JSON.parse(alice.sent[0]!)).toMatchObject({ type: 'status', code: ORDERS_ENGINE_UNAVAILABLE });
  });

  it('does not apply an older order seed row after a live publish during the seed await', async () => {
    let release!: (rows: readonly PrivateOrderUpdate[]) => void;
    const pending = new Promise<readonly PrivateOrderUpdate[]>((resolve) => {
      release = resolve;
    });
    const hub = new PrivateOrderHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 10,
      maxConnectionsPerUser: 10,
      seedOrders: () => pending,
    });
    const alice = sink();
    hub.attach('user-a', alice);

    const live = { ...update('user-a'), status: 'filled', filledQty: '1' };
    hub.publish(live);

    const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    release([update('user-a'), update('user-a', otherId)]);
    await pending;

    const frames = alice.sent.map((raw) => JSON.parse(raw) as { orderId: string; status: string; filledQty: string });
    expect(frames.filter((frame) => frame.orderId === live.orderId)).toEqual([
      expect.objectContaining({ orderId: live.orderId, status: 'filled', filledQty: '1' }),
    ]);
    expect(frames).toContainEqual(expect.objectContaining({ orderId: otherId, status: 'open', filledQty: '0' }));
  });

  it('does not apply an older position seed row after a live publish during the seed await', async () => {
    let release!: (rows: readonly PrivatePositionUpdate[]) => void;
    const pending = new Promise<readonly PrivatePositionUpdate[]>((resolve) => {
      release = resolve;
    });
    const hub = new PrivateOrderHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 10,
      maxConnectionsPerUser: 10,
      seedPositions: () => pending,
    });
    const alice = sink();
    hub.attach('user-a', alice);

    const live = { ...position('user-a'), status: 'closed' as const, contracts: '0' };
    hub.publishPosition(live);

    const otherId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    release([position('user-a'), position('user-a', otherId)]);
    await pending;

    const frames = alice.sent.map((raw) => JSON.parse(raw) as { positionId: string; status: string; contracts: string });
    expect(frames.filter((frame) => frame.positionId === live.positionId)).toEqual([
      expect.objectContaining({ positionId: live.positionId, status: 'closed', contracts: '0' }),
    ]);
    expect(frames).toContainEqual(expect.objectContaining({ positionId: otherId, status: 'open', contracts: '2' }));
  });

  it('still writes the cold order seed when the live row is held until snapshot', async () => {
    let release!: (rows: readonly PrivateOrderUpdate[]) => void;
    const pending = new Promise<readonly PrivateOrderUpdate[]>((resolve) => {
      release = resolve;
    });
    const hub = new PrivateOrderHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 10,
      maxConnectionsPerUser: 10,
      seedOrders: () => pending,
    });
    const alice = sink();
    hub.attach('user-a', alice, 'orders', { holdUntilSnapshot: true });

    const live = { ...update('user-a'), status: 'filled', filledQty: '1' };
    hub.publish(live);
    expect(alice.sent).toEqual([]);

    release([update('user-a')]);
    await pending;

    expect(alice.sent.map((raw) => JSON.parse(raw))).toEqual([
      expect.objectContaining({ orderId: live.orderId, status: 'open', filledQty: '0' }),
    ]);
    hub.releaseSnapshot(alice);
    expect(alice.sent.map((raw) => JSON.parse(raw))).toEqual([
      expect.objectContaining({ orderId: live.orderId, status: 'open', filledQty: '0' }),
      expect.objectContaining({ orderId: live.orderId, status: 'filled', filledQty: '1' }),
    ]);
  });

  it('applies the high-water lag check to live frames queued before hydration', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 10, maxLagTicks: 2, maxConnections: 10, maxConnectionsPerUser: 10 });
    const lagging = {
      sent: [] as string[],
      get bufferedBytes() {
        return 100;
      },
      send(frame: string) {
        this.sent.push(frame);
      },
      closed: null as { code: number; reason: string } | null,
      close(code: number, reason: string) {
        this.closed = { code, reason };
      },
    };
    const healthy = sink();
    hub.attach('user-a', lagging, 'orders', { holdUntilSnapshot: true });
    hub.attach('user-a', healthy, 'orders');

    hub.publish(update('user-a'));
    hub.publish(update('user-a', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));

    expect(lagging.closed?.code).toBe(1013);
    expect(lagging.closed?.reason).toMatch(/slow consumer/i);
    hub.releaseSnapshot(lagging);
    expect(lagging.sent).toHaveLength(0);
    expect(hub.connections).toBe(1);
    expect(healthy.sent).toHaveLength(2);
  });

  it('does not leave a stuck open-orders read blocked on an unbounded pending queue', () => {
    const hub = new PrivateOrderHub({ highWaterBytes: 10, maxLagTicks: 2, maxConnections: 10, maxConnectionsPerUser: 10 });
    const alice = sink();
    hub.attach('user-a', alice, 'orders', { holdUntilSnapshot: true });

    hub.publish(update('user-a'));
    expect(alice.closed).toBeNull();
    expect(alice.sent).toHaveLength(0);

    hub.sweepLag();
    expect(alice.closed).toBeNull();
    hub.sweepLag();

    expect(alice.closed?.code).toBe(1013);
    expect(hub.connections).toBe(0);
    hub.releaseSnapshot(alice);
    expect(alice.sent).toHaveLength(0);
  });
});
