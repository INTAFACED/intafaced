import { TEST_AUTHORITY } from '../test-support/authority.js';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { isLiveZeroBlotterFrame, PrivateOrderHub } from './hub.js';
import { createPrivateWebSocketGateway, PRIVATE_STREAM_PATH, type PrivateWebSocketGateway } from './gateway.js';
import { wouldInventCodMassSuccessFrame, type TradeCancelPort } from './cod.js';
import type { HubLogger } from '../depth/hub.js';

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RANGE = { minTtlMs: 50, maxTtlMs: 60_000 };

const tokens: TokenConfig = {
  secret: SECRET,
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

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

  async untilSnapshot(channel: 'orders' | 'positions' = 'orders'): Promise<void> {
    for (;;) {
      if (this.parsed().some((f) => f.channel === channel && f.type === 'snapshot')) return;
      if (this.closed) throw new Error(`closed before ${channel} snapshot`);
      await this.frameCount(this.frames.length + 1);
    }
  }

  async untilType(type: string): Promise<Record<string, unknown>> {
    for (;;) {
      const hit = this.parsed().find((f) => f.type === type);
      if (hit) return hit;
      if (this.closed) throw new Error(`closed before ${type}`);
      await this.frameCount(this.frames.length + 1);
    }
  }
}

describe('private COD gateway', () => {
  let server: Server;
  let hub: PrivateOrderHub;
  let gateway: PrivateWebSocketGateway;
  let baseUrl: string;

  afterEach(async () => {
    await gateway?.close('test done');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(
    opts: {
      tradeCancel?: TradeCancelPort | null;
      codRange?: { minTtlMs: number; maxTtlMs: number } | null;
    } = {},
  ): Promise<void> {
    hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    baseUrl = `ws://127.0.0.1:${addr.port}`;
    const log: HubLogger = { info: () => undefined, warn: () => undefined };
    gateway = createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub,
      heartbeatMs: 30_000,
      log,
      enabled: () => true,
      tokens,
      book: {
        async listOpenOrders() {
          return [
            {
              orderId: 'oooooooo-oooo-4ooo-8ooo-oooooooooooo',
              userId: USER,
              marketId: 'BTC-USDT',
              status: 'open',
              side: 'buy',
              type: 'limit',
              qty: '1',
              filledQty: '0',
              price: '100',
              clientOrderId: null,
              ts: '2026-08-25T00:00:00.000Z',
            },
          ];
        },
        async listOpenPositions() {
          return [];
        },
      },
      codRange: opts.codRange === undefined ? RANGE : opts.codRange,
      tradeCancel: opts.tradeCancel ?? null,
    });
  }

  async function connect(scopes: string[]): Promise<Client> {
    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes }, tokens);
    const client = new Client(`${baseUrl}${PRIVATE_STREAM_PATH}?access_token=${token}`);
    await client.untilSnapshot('orders');
    return client;
  }

  it('refuses arm when owner lease range is unset', async () => {
    await boot({ codRange: null });
    const client = await connect(['trade:write']);
    const before = client.frames.length;
    client.socket.send(JSON.stringify({ type: 'cod.arm', commandId: 'c1', ttlMs: 1_000, scope: 'account' }));
    await client.frameCount(before + 1);
    expect(client.parsed().at(-1)).toMatchObject({ type: 'cod.refused', code: 'cod.lease_range_unconfigured' });
  });

  it('ignores a client expiresAt and arms from server receipt', async () => {
    await boot();
    const client = await connect(['trade:write']);
    const before = Date.now();
    client.socket.send(
      JSON.stringify({
        type: 'cod.arm',
        commandId: 'c1',
        ttlMs: 5_000,
        scope: 'account',
        expiresAt: '1999-01-01T00:00:00.000Z',
        clientNow: 1,
      }),
    );
    const armed = await client.untilType('cod.armed');
    const expiresAt = Date.parse(String(armed.expiresAt));
    const receivedAt = Date.parse(String(armed.receivedAt));
    expect(receivedAt).toBeGreaterThanOrEqual(before - 50);
    expect(expiresAt - receivedAt).toBe(5_000);
    expect(String(armed.expiresAt).startsWith('1999')).toBe(false);
    expect(armed.cancelExecutable).toBe(false);
  });

  it('socket death fires UNKNOWN when trade was not reached — not an empty complete blotter', async () => {
    await boot();
    const client = await connect(['trade:write']);
    client.socket.send(JSON.stringify({ type: 'cod.arm', commandId: 'c1', ttlMs: 30_000, scope: 'account' }));
    await client.untilType('cod.armed');
    const waiter = await connect(['trade:write']);
    client.socket.terminate();
    const fired = await waiter.untilType('cod.fired');
    expect(fired).toMatchObject({
      activation: 'disconnect',
      tradeReached: false,
      complete: false,
    });
    expect((fired.targets as { outcome: string }[])[0]!.outcome).toBe('OUTCOME_UNKNOWN');
    for (const frame of waiter.frames) {
      expect(wouldInventCodMassSuccessFrame(frame)).toBe(false);
      expect(isLiveZeroBlotterFrame(frame)).toBe(false);
    }
    const snaps = waiter.parsed().filter((f) => f.channel === 'orders' && f.type === 'snapshot');
    expect(snaps.every((s) => Array.isArray(s.orders) && (s.orders as unknown[]).length > 0)).toBe(true);
  });

  it('session scope never calls cancelAll (would widen to the whole account)', async () => {
    const calls: unknown[] = [];
    await boot({
      tradeCancel: {
        async cancelAll(input) {
          calls.push(input);
          return { reached: true, status: 200, orders: [{ orderId: 'invented' }] };
        },
      },
    });
    const client = await connect(['trade:write']);
    client.socket.send(JSON.stringify({ type: 'cod.arm', commandId: 'c1', ttlMs: 30_000, scope: 'session' }));
    await client.untilType('cod.armed');
    const waiter = await connect(['trade:write']);
    client.socket.close();
    const fired = await waiter.untilType('cod.fired');
    expect(calls).toEqual([]);
    expect(fired.tradeReached).toBe(false);
    expect((fired.targets as { reason?: string }[])[0]!.reason).toBe('cod.session_scope_not_mapped');
  });

  it('account scope reports per-target APPLIED only when trade returns cancels', async () => {
    const calls: Array<{ accessToken: string; marketId?: string }> = [];
    await boot({
      tradeCancel: {
        async cancelAll(input) {
          calls.push(input);
          return { reached: true, status: 200, orders: [{ orderId: 'o-1' }, { orderId: 'o-2' }] };
        },
      },
    });
    const client = await connect(['trade:write']);
    client.socket.send(JSON.stringify({ type: 'cod.arm', commandId: 'c1', ttlMs: 30_000, scope: 'account' }));
    const armed = await client.untilType('cod.armed');
    expect(armed.cancelExecutable).toBe(true);
    const waiter = await connect(['trade:write']);
    client.socket.close();
    const fired = await waiter.untilType('cod.fired');
    expect(calls).toHaveLength(1);
    expect(fired).toMatchObject({ tradeReached: true, complete: true });
    expect(fired.targets).toEqual([
      { selector: 'o-1', outcome: 'APPLIED' },
      { selector: 'o-2', outcome: 'APPLIED' },
    ]);
  });

  it('read-only seat cannot arm', async () => {
    await boot();
    const client = await connect(['trade:read']);
    client.socket.send(JSON.stringify({ type: 'cod.arm', commandId: 'c1', ttlMs: 1_000, scope: 'account' }));
    const refused = await client.untilType('cod.refused');
    expect(refused.code).toBe('cod.write_required');
  });
});
