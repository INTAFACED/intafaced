import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  applyDelta,
  bookFromSnapshot,
  TRADE_PRINT_KIND_UNKNOWN,
  TRADE_PRINT_PUBLIC_KEYS,
  type DepthBook,
  type DepthMessage,
  type DepthSnapshot,
  type TradePrint,
} from '@intafaced/market-data';
import { DepthHub } from '../depth/hub.js';
import { DepthNoBookError, type DepthSource } from '../depth/source.js';
import { PrivateOrderHub } from '../private/hub.js';
import { registerRoutes } from '../routes.js';
import { TradeHub } from '../trade/hub.js';
import { createWebSocketGateway, type WebSocketGateway } from './gateway.js';

/**
 * END TO END, OVER A REAL SOCKET.
 *
 * The hub tests prove the fan-out logic against a fake sink. These prove the
 * glue: that the query parameter is the whole subscription vocabulary, that an
 * unknown market never gets as far as a depth call, that inbound frames are
 * ignored rather than interpreted, and that a browser can rebuild the server's
 * book from the bytes that actually cross a TCP connection.
 */

const MARKET = 'BTC-USDT';

function snapshot(sequence: number, bids: Array<[string, string]> = [['100', '1']], marketId = MARKET): DepthSnapshot {
  return { type: 'snapshot', marketId, sequence, bids, asks: [['101', '1']] };
}

class StubSource implements DepthSource {
  marketList: string[] = [MARKET];
  readonly snapshotCalls: string[] = [];
  current: DepthSnapshot = snapshot(10);

  async markets(): Promise<readonly string[]> {
    return this.marketList;
  }

  async snapshot(marketId: string): Promise<DepthSnapshot> {
    this.snapshotCalls.push(marketId);
    return { ...this.current, marketId };
  }
}

/** Collects frames off a live socket and lets a test wait for the nth one. */
class Client {
  readonly socket: WebSocket;
  readonly frames: string[] = [];
  closed: { code: number; reason: string } | null = null;
  readonly #waiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(url: string, headers?: Record<string, string>, opts?: { autoPong?: boolean }) {
    this.socket = new WebSocket(url, {
      ...(headers ? { headers } : {}),
      ...(opts?.autoPong === false ? { autoPong: false } : {}),
    });
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

  /** Resolves when `count` frames have arrived, or the socket closed. */
  async frameCount(count: number): Promise<void> {
    if (this.frames.length >= count || this.closed) return;
    await new Promise<void>((resolve) => this.#waiters.push({ count, resolve }));
  }

  async closure(): Promise<{ code: number; reason: string }> {
    if (this.closed) return this.closed;
    await new Promise<void>((resolve) => this.socket.once('close', () => resolve()));
    return this.closed!;
  }

  messages(): DepthMessage[] {
    return this.frames.map((f) => JSON.parse(f) as DepthMessage);
  }

  /** The book a browser would hold, from these frames alone. */
  book(): DepthBook | null {
    let book: DepthBook | null = null;
    for (const message of this.messages()) {
      if (message.type === 'snapshot') {
        book = bookFromSnapshot(message);
        continue;
      }
      if (!book) throw new Error('delta before snapshot');
      const result = applyDelta(book, message);
      if (!result.ok) throw new Error(`client refused a delta: ${result.reason}`);
      book = result.book;
    }
    return book;
  }

  dispose(): void {
    this.socket.terminate();
  }
}

/** A failed upgrade answers with an HTTP status rather than a socket. */
async function upgradeStatus(url: string): Promise<number> {
  const socket = new WebSocket(url);
  return new Promise<number>((resolve) => {
    socket.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.on('error', () => resolve(0));
    socket.on('open', () => {
      socket.terminate();
      resolve(101);
    });
  });
}

const log = { info: vi.fn(), warn: vi.fn() };

describe('the websocket gateway, over a real socket', () => {
  let app: FastifyInstance;
  let hub: DepthHub;
  let tradeHub: TradeHub;
  let source: StubSource;
  let gateway: WebSocketGateway;
  let base: string;
  let enabled = true;
  const clients: Client[] = [];

  beforeEach(async () => {
    enabled = true;
    source = new StubSource();
    app = Fastify({ logger: false });
    hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 4,
      marketsRefreshMs: 0,
    });
    tradeHub = new TradeHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 4,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    const privateHub = new PrivateOrderHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 4,
      maxConnectionsPerUser: 4,
    });
    registerRoutes(app, {
      hub,
      tradeHub,
      privateHub,
      source,
      depthLimit: 50,
      serviceName: 'svc-ws-test',
      upstream: 'http://matching.test',
      enabled: () => enabled,
      tradesBus: () => true,
      privateBus: () => false,
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `127.0.0.1:${port}`;

    gateway = createWebSocketGateway({
      server: app.server,
      hub,
      tradeHub,
      heartbeatMs: 60_000,
      log,
      enabled: () => enabled,
    });
    await hub.refreshMarkets();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    await gateway.close('test over');
    await app.close();
  });

  function connect(query: string, headers?: Record<string, string>, opts?: { autoPong?: boolean }): Client {
    const client = new Client(`ws://${base}/stream?${query}`, headers, opts);
    clients.push(client);
    return client;
  }

  it('sends a snapshot on connect and deltas thereafter', async () => {
    const client = connect(`market=${MARKET}`);
    await client.frameCount(1);

    expect(client.messages()[0]).toMatchObject({ type: 'snapshot', marketId: MARKET, sequence: 10 });

    hub.ingest(snapshot(11, [['100', '2']]));
    hub.ingest(
      snapshot(12, [
        ['100', '2'],
        ['99', '4'],
      ]),
    );
    await client.frameCount(3);

    const book = client.book();
    expect(book?.sequence).toBe(12);
    expect(book?.bids.get('99')).toBe(4n * 10n ** 18n);
  });

  it('serves two clients on one market the same stream', async () => {
    const first = connect(`market=${MARKET}`);
    await first.frameCount(1);
    const second = connect(`market=${MARKET}`);
    await second.frameCount(1);

    hub.ingest(snapshot(11, [['100', '5']]));
    await Promise.all([first.frameCount(2), second.frameCount(2)]);

    expect(first.book()?.sequence).toBe(11);
    expect(second.book()?.sequence).toBe(11);
  });

  it('closes a subscription to a market the engine has no book for', async () => {
    const client = connect('market=NOPE-NOPE');
    const closed = await client.closure();

    // Policy violation (1008), not an internal error path stacked on top of
    // capacity / try-later codes. Unknown market is a single, stable close.
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe('ws.close.unknown_market');
    // And critically: no depth call was made, so nothing was allocated upstream.
    expect(source.snapshotCalls).toEqual([]);
  });

  it('opens the public stream from any Origin — there is nothing to authorise', async () => {
    // Cross-site WebSocket hijacking only matters when ambient credentials ride
    // the upgrade. This port carries none, so Origin is not a gate (gateway.ts).
    const client = connect(`market=${MARKET}`, { Origin: 'https://evil.example' });
    await client.frameCount(1);

    expect(client.messages()[0]).toMatchObject({ type: 'snapshot', marketId: MARKET, sequence: 10 });
    expect(client.closed).toBeNull();
  });

  it('never interprets an inbound frame', async () => {
    const client = connect(`market=${MARKET}`);
    await client.frameCount(1);

    // Anything a client can say. None of it is parsed, so none of it can do
    // anything — there is no command vocabulary to abuse.
    client.socket.send(JSON.stringify({ op: 'subscribe', marketId: 'ETH-USDT' }));
    client.socket.send('}{ not json');
    client.socket.send(JSON.stringify({ type: 'snapshot', marketId: MARKET, sequence: 999, bids: [], asks: [] }));

    hub.ingest(snapshot(11, [['100', '2']]));
    await client.frameCount(2);

    expect(client.messages().every((m) => m.marketId === MARKET)).toBe(true);
    expect(client.book()?.sequence).toBe(11);
    expect(client.closed).toBeNull();
  });

  it('survives an oversized inbound frame without taking the process down', async () => {
    // maxPayload is 1 KiB on the public WSS. The library may drop the offender;
    // the pin is that the service keeps serving other subscribers.
    const victim = connect(`market=${MARKET}`);
    await victim.frameCount(1);

    victim.socket.send('x'.repeat(8_000));

    // Either the library closed the fat socket (1009) or ignored the frame —
    // either way a second client must still get a clean snapshot.
    const peer = connect(`market=${MARKET}`);
    await peer.frameCount(1);
    expect(peer.messages()[0]).toMatchObject({ type: 'snapshot', marketId: MARKET });
    expect(peer.closed).toBeNull();

    hub.ingest(snapshot(11, [['100', '2']]));
    await peer.frameCount(2);
    expect(peer.book()?.sequence).toBe(11);
  });

  it('evicts a flood of unknown markets so capacity is not permanently burned', async () => {
    // attach counts then #open async-evicts unknowns. Slot burn is brief; after
    // settle, twice capacity of pure junk must leave zero live subscriptions.
    const capacity = 4;
    const junk = Array.from({ length: capacity * 2 }, (_, i) => connect(`market=JUNK-${i}`));
    const closures = await Promise.all(junk.map((c) => c.closure()));

    for (const closed of closures) {
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe('ws.close.unknown_market');
    }
    expect(hub.connections).toBe(0);
    expect(source.snapshotCalls).toEqual([]);
  });

  it('refuses an upgrade with no market, an unknown path, or the switch off', async () => {
    expect(await upgradeStatus(`ws://${base}/stream`)).toBe(400);
    expect(await upgradeStatus(`ws://${base}/stream?market=${'x'.repeat(65)}`)).toBe(400);
    expect(await upgradeStatus(`ws://${base}/anything-else?market=${MARKET}`)).toBe(404);

    enabled = false;
    expect(await upgradeStatus(`ws://${base}/stream?market=${MARKET}`)).toBe(503);
  });

  it('detaches the subscription when the socket closes', async () => {
    const client = connect(`market=${MARKET}`);
    await client.frameCount(1);
    expect(hub.connections).toBe(1);

    client.socket.close();
    await client.closure();
    // close → detach is same-tick on the server; poll briefly if the event loop is busy.
    for (let i = 0; i < 20 && hub.connections !== 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(hub.connections).toBe(0);
    // The book goes with it — a book nobody watches goes stale, and a stale
    // book handed out as a "snapshot" is a lie with a sequence number on it.
    expect(hub.bookFor(MARKET)).toBeUndefined();
  });

  it('tells every client why when the gateway shuts down', async () => {
    const client = connect(`market=${MARKET}`);
    await client.frameCount(1);

    await gateway.close('ws.close.shutting_down');
    const closed = await client.closure();

    expect(closed.code).toBe(1001);
    expect(closed.reason).toBe('ws.close.shutting_down');
  });

  it('streams public trade prints on channel=trades — no order/account ids, no invented side', async () => {
    const makerOrderId = '11111111-1111-1111-1111-111111111111';
    const takerOrderId = '22222222-2222-2222-2222-222222222222';
    const makerAccountId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const takerAccountId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    // Open the tape first — unwatched markets do not pin a ring (W7 residual).
    const watching = tradeHub.connections;
    const client = connect(`market=${MARKET}&channel=trades`);
    // Wait until the hub holds the subscription: a print before that has no watcher and is dropped. A fixed 50 ms was not
    // always enough on a loaded runner, and the print never came (#6027). With a ring, a print held while the seat is
    // still opening is replayed to it.
    const until = Date.now() + 4_000;
    while (tradeHub.connections <= watching) {
      if (Date.now() > until) throw new Error('the trades subscription never reached the hub');
      await new Promise((r) => setTimeout(r, 5));
    }

    tradeHub.ingest({
      marketId: MARKET,
      makerOrderId,
      takerOrderId,
      price: '30100.5',
      qty: '0.1',
      sequence: 50,
      ts: '2026-07-29T12:00:00.000Z',
      // Residual: private / inventable fields must not cross the gateway wire.
      makerAccountId,
      takerAccountId,
      house: true,
      side: 'buy',
    } as never);

    await client.frameCount(1);

    const wire = client.frames[0]!;
    const print = JSON.parse(wire) as TradePrint;
    expect(Object.keys(print).sort()).toEqual([...TRADE_PRINT_PUBLIC_KEYS].sort());
    expect(print).toEqual({
      type: 'trade',
      marketId: MARKET,
      sequence: 50,
      price: '30100.5',
      quantity: '0.1',
      ts: '2026-07-29T12:00:00.000Z',
      kind: TRADE_PRINT_KIND_UNKNOWN,
    });
    expect(print).not.toHaveProperty('side');
    for (const secret of [
      makerOrderId,
      takerOrderId,
      makerAccountId,
      takerAccountId,
      'makerOrderId',
      'takerOrderId',
      'makerAccountId',
      'takerAccountId',
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(wire).not.toMatch(/"side"/);

    tradeHub.ingest({
      marketId: MARKET,
      price: '30101',
      qty: '0.2',
      sequence: 51,
      ts: '2026-07-29T12:00:01.000Z',
      side: 'sell',
    } as never);
    await client.frameCount(2);
    const live = JSON.parse(client.frames[1]!) as TradePrint;
    expect(live).toMatchObject({ type: 'trade', sequence: 51, quantity: '0.2' });
    expect(live).not.toHaveProperty('side');
    expect(Object.keys(live).sort()).toEqual([...TRADE_PRINT_PUBLIC_KEYS].sort());
  });

  it('refuses an unknown channel on the upgrade', async () => {
    expect(await upgradeStatus(`ws://${base}/stream?market=${MARKET}&channel=orders`)).toBe(400);
    expect(await upgradeStatus(`ws://${base}/stream?market=${MARKET}&channel=positions`)).toBe(400);
  });

  it('terminates a public socket that stops answering pings and frees the hub seat', async () => {
    // Rebuild gateway with a short heartbeat so the miss-pong path is testable.
    // autoPong:false is the ws@8 contract so a dead peer cannot keep a hub seat.
    await gateway.close('reconfigure heartbeat');
    gateway = createWebSocketGateway({
      server: app.server,
      hub,
      tradeHub,
      heartbeatMs: 50,
      log,
      enabled: () => enabled,
    });

    const client = connect(`market=${MARKET}`, undefined, { autoPong: false });
    await client.frameCount(1);
    expect(hub.connections).toBe(1);

    // Two heartbeat windows: first marks not-alive + ping; second terminates.
    await Promise.race([client.closure(), new Promise<void>((r) => setTimeout(r, 2_000))]);
    expect(client.closed).not.toBeNull();
    const deadline = Date.now() + 2_000;
    while (hub.connections !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(hub.connections).toBe(0);
  });
});

describe('the HTTP half', () => {
  let app: FastifyInstance;
  let hub: DepthHub;
  let tradeHub: TradeHub;
  let privateHub: PrivateOrderHub;
  let source: StubSource;
  let enabled = true;
  let tradesBusUp = false;
  let privateBusUp = false;

  beforeEach(async () => {
    enabled = true;
    tradesBusUp = false;
    privateBusUp = false;
    source = new StubSource();
    app = Fastify({ logger: false });
    hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 4,
      marketsRefreshMs: 0,
    });
    tradeHub = new TradeHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 4,
      recentLimit: 10,
      ensureKnownMarket: (id) => hub.ensureKnownMarket(id),
    });
    privateHub = new PrivateOrderHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 4,
      maxConnectionsPerUser: 4,
    });
    registerRoutes(app, {
      hub,
      tradeHub,
      privateHub,
      source,
      depthLimit: 50,
      serviceName: 'svc-ws-test',
      upstream: 'http://matching.test',
      enabled: () => enabled,
      tradesBus: () => tradesBusUp,
      privateBus: () => privateBusUp,
    });
    await app.ready();
    await hub.refreshMarkets();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves a snapshot a browser can read cross-origin', async () => {
    const response = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });

    expect(response.statusCode).toBe(200);
    // No credentials are involved anywhere on this route, so "any origin may
    // read this" is a true statement rather than a relaxation.
    expect(response.headers['access-control-allow-origin']).toBe('*');
    // Wildcard + Allow-Credentials would be illegal CORS; we never ask for
    // cookies on a public price feed, so the credentials header stays absent.
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.json()).toMatchObject({ type: 'snapshot', marketId: MARKET, sequence: 10 });
  });

  it('lists markets without Allow-Credentials either', async () => {
    const response = await app.inject({ method: 'GET', url: '/markets' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.json()).toMatchObject({ markets: [MARKET] });
  });

  it('404s an unknown market without asking svc-matching for its depth', async () => {
    const response = await app.inject({ method: 'GET', url: '/markets/NOPE-NOPE/depth' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'MarketNotFound' });
    expect(source.snapshotCalls).toEqual([]);
  });

  it('404s NoBook when matching holds no book — never a 200 empty ladder', async () => {
    source.snapshot = async (marketId: string) => {
      source.snapshotCalls.push(marketId);
      throw new DepthNoBookError(marketId);
    };

    const response = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NoBook' });
    expect(response.json()).not.toMatchObject({ bids: [], asks: [] });
  });

  it('404s NoTape when a listed market has no prints — never a 200 empty tape', async () => {
    const response = await app.inject({ method: 'GET', url: `/markets/${MARKET}/trades` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NoTape' });
    expect(response.json()).not.toMatchObject({ trades: [] });
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('404s an unknown market on the trades GET without a fabricated empty tape', async () => {
    const response = await app.inject({ method: 'GET', url: '/markets/NOPE-NOPE/trades' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'MarketNotFound' });
    expect(response.json()).not.toMatchObject({ trades: [] });
  });

  it('404s NoBlotter for a listed market — never a 200 empty orders book', async () => {
    const response = await app.inject({ method: 'GET', url: `/markets/${MARKET}/orders` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NoBlotter' });
    expect(response.json()).not.toMatchObject({ orders: [] });
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('404s an unknown market on the orders GET without a fabricated empty blotter', async () => {
    const response = await app.inject({ method: 'GET', url: '/markets/NOPE-NOPE/orders' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'MarketNotFound' });
    expect(response.json()).not.toMatchObject({ orders: [] });
  });

  it('404s NoPositions for a listed market — never a 200 empty positions book', async () => {
    const response = await app.inject({ method: 'GET', url: `/markets/${MARKET}/positions` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NoPositions' });
    expect(response.json()).not.toMatchObject({ positions: [] });
  });

  it('404s an unknown market on the positions GET without a fabricated empty blotter', async () => {
    const response = await app.inject({ method: 'GET', url: '/markets/NOPE-NOPE/positions' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'MarketNotFound' });
    expect(response.json()).not.toMatchObject({ positions: [] });
  });

  it('serves recent public prints when the tape is live — not an empty wrapper', async () => {
    const sink = { bufferedBytes: 0, send: () => undefined, close: () => undefined };
    tradeHub.attach(MARKET, sink);
    await new Promise((resolve) => setTimeout(resolve, 0));
    tradeHub.ingest({
      marketId: MARKET,
      price: '30100.5',
      qty: '0.1',
      sequence: 50,
      ts: '2026-07-29T12:00:00.000Z',
    });

    const response = await app.inject({ method: 'GET', url: `/markets/${MARKET}/trades` });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { marketId: string; trades: TradePrint[] };
    expect(body.marketId).toBe(MARKET);
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0]).toMatchObject({ type: 'trade', sequence: 50, price: '30100.5', quantity: '0.1' });
    expect(body.trades[0]).not.toHaveProperty('side');
  });

  it('400s a market id that could never be one', async () => {
    const response = await app.inject({ method: 'GET', url: '/markets/..%2F..%2Fetc/depth' });
    expect(response.statusCode).toBe(400);
    expect(source.snapshotCalls).toEqual([]);
  });

  it('serves the socket’s own book, so a resnapshot cannot land between two truths', async () => {
    // Warm the hub, then move it on. The GET must answer with what the deltas
    // are diffed against, not with a fresh upstream read.
    const sink = { bufferedBytes: 0, send: () => undefined, close: () => undefined };
    hub.attach(MARKET, sink);
    await new Promise((resolve) => setTimeout(resolve, 0));
    hub.ingest(snapshot(77, [['100', '3']]));
    source.current = snapshot(999); // upstream has moved on; we must not read it

    const response = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });

    expect(response.json()).toMatchObject({ sequence: 77 });
  });

  it('answers 502 when svc-matching is down, not 500', async () => {
    source.snapshot = async () => {
      throw new Error('svc-matching unreachable: ECONNREFUSED');
    };

    const response = await app.inject({ method: 'GET', url: `/markets/${MARKET}/depth` });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: 'depth.engine_unavailable' });
  });

  it('reports not-ready when the kill-switch is off, while staying alive', async () => {
    enabled = false;

    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, enabled: false });
  });

  it('stays ready when the bus is down and exposes the subscription flags', async () => {
    tradesBusUp = false;
    privateBusUp = false;

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ready: true,
      tradesBus: false,
      privateBus: false,
      privateConnections: 0,
    });

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      ok: true,
      tradesBus: false,
      privateBus: false,
      privateConnections: 0,
    });
  });

  it('publishes per-hub connection ceilings on /health without 503ing on occupancy', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      ok: true,
      capacity: {
        depth: { connections: 0, maxConnections: 4 },
        trades: { connections: 0, maxConnections: 4 },
        private: { connections: 0, maxConnections: 4, maxConnectionsPerUser: 4 },
      },
    });
  });

  it('reports bus up when getters say the subscriptions are live', async () => {
    tradesBusUp = true;
    privateBusUp = true;

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ready: true, tradesBus: true, privateBus: true });
  });
});
