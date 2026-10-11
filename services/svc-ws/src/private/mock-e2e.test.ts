import { TEST_AUTHORITY } from '../test-support/authority.js';
/**
 * A-WS-MOCK-E2E — private stream integration with fixture bus events.
 *
 * Full path (no live futures, no invent):
 *   MemoryEventBus → subscribePrivate* → PrivateOrderHub → /private/stream → WS client
 *
 * Auth fail-closed is covered in gateway.test.ts; this file proves the three
 * private channels deliver catalog-shaped fixtures end-to-end and stay silent
 * until a real event is published.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { MemoryEventBus, validatePayload } from '@intafaced/events';
import { PrivateOrderHub } from './hub.js';
import { createPrivateWebSocketGateway, PRIVATE_STREAM_PATH, type PrivateWebSocketGateway } from './gateway.js';
import { subscribePrivateFills, subscribePrivateOrders, subscribePrivatePositions } from './source.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORDER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FILL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const POSITION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

/** Catalog-valid fixture events — mock only; not live futures. */
const FIXTURE_ORDER = validatePayload('orderUpdated', {
  orderId: ORDER_ID,
  userId: USER,
  marketId: 'btc-usdt',
  status: 'open',
  side: 'buy',
  type: 'limit',
  qty: '2.5',
  filledQty: '0.5',
  price: '64000.25',
  clientOrderId: 'mock-e2e-cli-1',
  ts: '2026-08-02T12:00:00.000Z',
});

const FIXTURE_FILL = validatePayload('fillSettled', {
  fillId: FILL_ID,
  orderId: ORDER_ID,
  userId: USER,
  marketId: 'btc-usdt',
  side: 'buy',
  liquidity: 'maker',
  price: '64000.25',
  qty: '0.5',
  quoteAmount: '32000.125',
  feeAsset: 'USDT',
  feeAmount: '3.2000125',
  feeBps: 10,
  sequence: 1,
  ts: '2026-08-02T12:00:01.000Z',
});

const FIXTURE_POSITION = validatePayload('positionUpdated', {
  positionId: POSITION_ID,
  userId: USER,
  marketId: 'btc-usdt-perp',
  symbol: 'BTC/USDT:USDT',
  status: 'open',
  side: 'long',
  contracts: '1.5',
  entryPrice: '64000',
  markPrice: '64100.5',
  notional: '96150.75',
  leverage: '5',
  collateral: '19230.15',
  unrealizedPnl: '150.75',
  realizedPnl: '0',
  liquidationPrice: '52000',
  marginMode: 'cross',
  fundingPaid: '-0.12',
  ts: '2026-08-02T12:00:02.000Z',
});

class Client {
  readonly socket: WebSocket;
  readonly frames: string[] = [];
  closed: { code: number; reason: string } | null = null;
  readonly #waiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (data) => {
      this.frames.push(data.toString());
      this.#settle();
    });
    this.socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.#settle();
    });
    this.socket.on('error', () => undefined);
  }

  #settle(): void {
    for (const waiter of [...this.#waiters]) {
      if (this.frames.length >= waiter.count || this.closed) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  async frameCount(count: number): Promise<void> {
    if (this.frames.length >= count || this.closed) return;
    await new Promise<void>((resolve) => this.#waiters.push({ count, resolve }));
  }

  parsed(): Array<Record<string, unknown>> {
    return this.frames.map((f) => JSON.parse(f) as Record<string, unknown>);
  }
}

describe('A-WS-MOCK-E2E private stream (fixture bus → socket)', () => {
  let server: Server;
  let hub: PrivateOrderHub;
  let gateway: PrivateWebSocketGateway;
  let bus: MemoryEventBus;
  let baseUrl: string;

  afterEach(async () => {
    await gateway?.close('test done');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(): Promise<void> {
    bus = new MemoryEventBus('svc-ws-mock-e2e');
    hub = new PrivateOrderHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 10,
      maxConnectionsPerUser: 10,
    });
    await subscribePrivateOrders({ bus, hub, durable: 'ws-mock-e2e-orders' });
    await subscribePrivateFills({ bus, hub, durable: 'ws-mock-e2e-fills' });
    await subscribePrivatePositions({ bus, hub, durable: 'ws-mock-e2e-positions' });

    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    baseUrl = `ws://127.0.0.1:${addr.port}`;
    gateway = createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub,
      heartbeatMs: 30_000,
      log: { info: () => undefined, warn: () => undefined },
      enabled: () => true,
      tokens,
    });
  }

  async function connectOwner(query = ''): Promise<Client> {
    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'] }, tokens);
    const client = new Client(`${baseUrl}${PRIVATE_STREAM_PATH}?access_token=${token}${query}`);
    const readyCount = query.includes('channel=orders') || query.includes('channel=fills') || query.includes('channel=positions') ? 1 : 3;
    await client.frameCount(readyCount);
    for (;;) {
      if (client.parsed().some((f) => f.channel === 'orders' && f.type === 'snapshot')) break;
      if (client.closed) throw new Error('closed before orders snapshot');
      await client.frameCount(client.frames.length + 1);
    }
    return client;
  }

  it('delivers fixture orderUpdated, fillSettled, and positionUpdated over /private/stream', async () => {
    await boot();
    const client = await connectOwner();

    const hello = client.parsed().filter((f) => f.type === 'ready' || f.type === 'snapshot');
    const readyChannels = hello
      .filter((f) => f.type === 'ready')
      .map((f) => f.channel)
      .sort();
    expect(readyChannels).toEqual(['fills', 'orders', 'positions']);
    expect(hello.find((f) => f.channel === 'orders' && f.type === 'snapshot')).toMatchObject({ orders: [] });

    const before = client.frames.length;
    await bus.publish('orderUpdated', FIXTURE_ORDER);
    await bus.publish('fillSettled', FIXTURE_FILL);
    await bus.publish('positionUpdated', FIXTURE_POSITION);

    await client.frameCount(before + 3);
    const live = client.parsed().filter((f) => f.type !== 'ready' && f.type !== 'snapshot');
    expect(live).toHaveLength(3);

    const order = live[0]!;
    const fill = live[1]!;
    const position = live[2]!;

    expect(order).toMatchObject({
      channel: 'orders',
      fact: 'ack',
      orderId: ORDER_ID,
      userId: USER,
      marketId: 'btc-usdt',
      status: 'open',
      side: 'buy',
      type: 'limit',
      qty: '2.5',
      filledQty: '0.5',
      price: '64000.25',
      clientOrderId: 'mock-e2e-cli-1',
    });
    expect(typeof order.qty).toBe('string');
    expect(typeof order.filledQty).toBe('string');
    expect(typeof order.price).toBe('string');

    expect(fill).toMatchObject({
      channel: 'fills',
      fact: 'fill',
      fillId: FILL_ID,
      orderId: ORDER_ID,
      userId: USER,
      price: '64000.25',
      qty: '0.5',
      quoteAmount: '32000.125',
      feeAmount: '3.2000125',
      feeBps: 10,
      sequence: 1,
    });
    expect(typeof fill.price).toBe('string');
    expect(typeof fill.qty).toBe('string');
    expect(typeof fill.quoteAmount).toBe('string');
    expect(typeof fill.feeAmount).toBe('string');

    expect(position).toMatchObject({
      channel: 'positions',
      positionId: POSITION_ID,
      userId: USER,
      marketId: 'btc-usdt-perp',
      symbol: 'BTC/USDT:USDT',
      status: 'open',
      side: 'long',
      contracts: '1.5',
      entryPrice: '64000',
      markPrice: '64100.5',
      notional: '96150.75',
      leverage: '5',
      collateral: '19230.15',
      unrealizedPnl: '150.75',
      realizedPnl: '0',
      liquidationPrice: '52000',
      marginMode: 'cross',
      fundingPaid: '-0.12',
    });
    expect(typeof position.contracts).toBe('string');
    expect(typeof position.notional).toBe('string');
    expect(typeof position.entryPrice).toBe('string');

    client.socket.close();
  });

  it('stays silent on data channels when no bus events fire (no invent live futures)', async () => {
    await boot();
    const client = await connectOwner();
    await new Promise((r) => setTimeout(r, 50));

    const live = client.parsed().filter((f) => f.type !== 'ready' && f.type !== 'snapshot');
    expect(live).toHaveLength(0);
    expect(client.parsed().some((f) => f.channel === 'orders' && f.type === 'snapshot')).toBe(true);

    client.socket.close();
  });

  it('channel=orders fans bus orderUpdated only — honest empty snapshot, no fills/positions invent', async () => {
    await boot();
    const client = await connectOwner('&channel=orders');

    const hello = client.parsed().filter((f) => f.type === 'ready' || f.type === 'snapshot');
    expect(hello.filter((f) => f.type === 'ready').map((f) => f.channel)).toEqual(['orders']);
    expect(hello.find((f) => f.channel === 'orders' && f.type === 'snapshot')).toMatchObject({ orders: [] });
    expect(hello.some((f) => f.channel === 'fills' || f.channel === 'positions')).toBe(false);

    const before = client.frames.length;
    await bus.publish('orderUpdated', FIXTURE_ORDER);
    await bus.publish('fillSettled', FIXTURE_FILL);
    await bus.publish('positionUpdated', FIXTURE_POSITION);
    await client.frameCount(before + 1);

    const live = client.parsed().filter((f) => f.type !== 'ready' && f.type !== 'snapshot');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ channel: 'orders', orderId: ORDER_ID, qty: '2.5' });
    client.socket.close();
  });

  it('does not deliver foreign-user fixtures to the authenticated socket', async () => {
    await boot();
    const client = await connectOwner();

    await bus.publish(
      'orderUpdated',
      validatePayload('orderUpdated', {
        ...FIXTURE_ORDER,
        orderId: '11111111-1111-4111-8111-111111111111',
        userId: OTHER,
      }),
    );
    await bus.publish(
      'fillSettled',
      validatePayload('fillSettled', {
        ...FIXTURE_FILL,
        fillId: '22222222-2222-4222-8222-222222222222',
        orderId: '11111111-1111-4111-8111-111111111111',
        userId: OTHER,
      }),
    );
    await bus.publish(
      'positionUpdated',
      validatePayload('positionUpdated', {
        ...FIXTURE_POSITION,
        positionId: '33333333-3333-4333-8333-333333333333',
        userId: OTHER,
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    const live = client.parsed().filter((f) => f.type !== 'ready' && f.type !== 'snapshot');
    expect(live).toHaveLength(0);
    client.socket.close();
  });
});

// ci: retrigger
