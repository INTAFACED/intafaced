/**
 * Futures desk positions stream.
 * Two accounts stay apart, an unauthenticated subscribe is refused, a sequence
 * gap is visible, and a resume either fills the missed deltas or sends a
 * fresh snapshot. Money on the frame is the decimal string that was published.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { PrivateOrderHub } from './hub.js';
import { HttpPrivateBookPort, type PrivateBookPort } from './book.js';
import { createPrivateWebSocketGateway, PRIVATE_STREAM_PATH, type PrivateWebSocketGateway } from './gateway.js';
import { TEST_AUTHORITY } from '../test-support/authority.js';
import {
  handlePositionsSubscribeText,
  POSITIONS_FOREIGN_ACCOUNT,
  POSITIONS_OPERATOR_SCOPE,
  POSITIONS_SOURCE_UNAVAILABLE,
  POSITIONS_UNAUTHENTICATED,
  PositionsStream,
  type PositionsFrame,
} from './positions-stream.js';

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AS_OF = '2026-10-17T04:00:00.000Z';

const tokens: TokenConfig = {
  secret: 'test-access-secret-at-least-32-chars!!',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

/** svc-trade `presentOpenPositions` row: no fundingPaid, marketId, or userId. */
function restOpenPosition(id: string, contracts: unknown, entryPrice = '64000.50'): Record<string, unknown> {
  return {
    id,
    symbol: 'BTC/USDT:USDT',
    timestamp: Date.parse('2026-10-17T03:00:00.000Z'),
    datetime: '2026-10-17T03:00:00.000Z',
    side: 'long',
    status: 'open',
    closingReason: null,
    contracts,
    contractSize: null,
    entryPrice,
    markPrice: '64100.5',
    notional: '64100.50',
    leverage: '5',
    collateral: '12820.10',
    initialMargin: '12820.10',
    maintenanceMargin: null,
    unrealizedPnl: '1.25',
    realizedPnl: '0',
    liquidationPrice: '51200',
    marginMode: 'isolated',
    percentage: null,
    markSource: null,
  };
}

function positionsChannel(frames: readonly unknown[]): Array<Record<string, unknown>> {
  return frames.filter((frame): frame is Record<string, unknown> => {
    return frame !== null && typeof frame === 'object' && (frame as { channel?: unknown }).channel === 'positions';
  });
}

async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (!ready()) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function ordersOrPositionsFetch(load: () => Response | Promise<Response>): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith('/api/v1/orders/open')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return load();
  };
}

function row(userId: string, positionId: string, contracts: unknown, entryPrice = '64000.50'): Record<string, unknown> {
  return {
    positionId,
    userId,
    marketId: 'btc-usdt-perp',
    symbol: 'BTC/USDT:USDT',
    status: 'open',
    side: 'long',
    contracts,
    entryPrice,
    markPrice: '64100.5',
    notional: '64100.50',
    leverage: '5',
    collateral: '12820.10',
    unrealizedPnl: '1.25',
    realizedPnl: '0',
    liquidationPrice: '51200',
    marginMode: 'isolated',
    fundingPaid: '-0.01',
    ts: AS_OF,
  };
}

describe('positions stream', () => {
  it('gives each account only its own snapshot and decimal-string deltas', async () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const aliceId = '11111111-1111-4111-8111-111111111111';
    const bobId = '22222222-2222-4222-8222-222222222222';
    expect(stream.ingest(row(ALICE, aliceId, '1.250000000000000001'))).toBe(true);
    expect(stream.ingest(row(BOB, bobId, '2'))).toBe(true);
    expect(stream.ingest(row(ALICE, aliceId, 1.25))).toBe(false);

    const alice: PositionsFrame[] = [];
    const bob: PositionsFrame[] = [];
    await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      accessToken: 'alice-token',
      seed: async () => [row(ALICE, aliceId, '1.250000000000000001')],
      send: (frame) => alice.push(frame),
    });
    await stream.subscribe({
      session: { userId: BOB, scopes: ['trade:read'] },
      asOf: AS_OF,
      accessToken: 'bob-token',
      seed: async () => [row(BOB, bobId, '2')],
      send: (frame) => bob.push(frame),
    });

    expect(alice[0]).toMatchObject({ channel: 'positions', type: 'snapshot', sequence: 1, resume: 'fresh' });
    const aliceSnap = alice[0];
    if (aliceSnap?.type !== 'snapshot') throw new Error('expected snapshot');
    expect(aliceSnap.positions).toHaveLength(1);
    expect(aliceSnap.positions[0]).toMatchObject({
      userId: ALICE,
      contracts: '1.250000000000000001',
      entryPrice: '64000.50',
      markPrice: '64100.5',
      fundingPaid: '-0.01',
    });
    expect(aliceSnap.positions.some((position) => position.userId === BOB)).toBe(false);
    expect(bob[0]).toMatchObject({ type: 'snapshot', sequence: 1 });
    const bobSnap = bob[0];
    if (bobSnap?.type !== 'snapshot') throw new Error('expected snapshot');
    expect(bobSnap.positions.map((position) => position.userId)).toEqual([BOB]);

    expect(stream.ingest(row(ALICE, aliceId, '3.5', '64000.50'))).toBe(true);
    expect(alice.at(-1)).toMatchObject({ type: 'delta', sequence: 2, position: { userId: ALICE, contracts: '3.5' } });
    expect(bob).toHaveLength(1);
  });

  it('refuses an unauthenticated subscribe and a session without admin:read asking for another account', async () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    stream.ingest(row(BOB, '22222222-2222-4222-8222-222222222222', '2'));
    const anon: PositionsFrame[] = [];
    const refused = await stream.subscribe({ session: null, asOf: AS_OF, send: (frame) => anon.push(frame) });
    expect(refused.ok).toBe(false);
    expect(anon).toEqual([expect.objectContaining({ type: 'error', code: POSITIONS_UNAUTHENTICATED })]);

    const foreign: PositionsFrame[] = [];
    await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      requestedUserId: BOB,
      asOf: AS_OF,
      send: (frame) => foreign.push(frame),
    });
    expect(foreign).toEqual([
      expect.objectContaining({
        type: 'error',
        code: POSITIONS_FOREIGN_ACCOUNT,
        key: POSITIONS_OPERATOR_SCOPE,
      }),
    ]);
    expect(JSON.stringify(foreign)).not.toContain('22222222');

    const bobId = '22222222-2222-4222-8222-222222222222';
    const bobSeeded: PositionsFrame[] = [];
    await stream.subscribe({
      session: { userId: BOB, scopes: ['trade:read'] },
      asOf: AS_OF,
      accessToken: 'bob-token',
      seed: async () => [restOpenPosition(bobId, '2')],
      send: (frame) => bobSeeded.push(frame),
    });
    const allowed: PositionsFrame[] = [];
    await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read', POSITIONS_OPERATOR_SCOPE] },
      requestedUserId: BOB,
      asOf: AS_OF,
      send: (frame) => allowed.push(frame),
    });
    expect(allowed[0]).toMatchObject({
      type: 'snapshot',
      positions: [expect.objectContaining({ userId: BOB, positionId: bobId, contracts: '2', fundingPaid: null })],
    });
  });

  it('refuses the stream shape when positionUpdated is not attached', async () => {
    const stream = new PositionsStream();
    const sent: PositionsFrame[] = [];
    await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      send: (frame) => sent.push(frame),
    });
    expect(sent).toEqual([expect.objectContaining({ type: 'error', code: POSITIONS_SOURCE_UNAVAILABLE })]);
    expect(sent.some((frame) => frame.type === 'snapshot')).toBe(false);
    expect(stream.ingest(row(ALICE, '11111111-1111-4111-8111-111111111111', '1'))).toBe(false);
  });

  it('detects a retained-sequence gap and a resume fills a contiguous tail', async () => {
    const stream = new PositionsStream({ retain: 1, streamId: 'retain-gap' });
    stream.markSourceAttached(true);
    const id = '11111111-1111-4111-8111-111111111111';
    expect(stream.ingest(row(ALICE, id, '1'))).toBe(true);
    expect(stream.ingest(row(ALICE, id, '2'))).toBe(true);
    expect(stream.ingest(row(ALICE, id, '3'))).toBe(true);

    const gapped: PositionsFrame[] = [];
    await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      lastSequence: 1,
      streamId: 'retain-gap',
      asOf: '2026-10-17T04:00:05.000Z',
      accessToken: 'alice-token',
      seed: async () => [row(ALICE, id, '3')],
      send: (frame) => gapped.push(frame),
    });
    expect(gapped).toHaveLength(1);
    expect(gapped[0]).toMatchObject({ type: 'snapshot', sequence: 3, resume: 'gap' });
    expect(gapped.some((frame) => frame.type === 'delta')).toBe(false);

    const full = new PositionsStream({ streamId: 'replay-tail' });
    full.markSourceAttached(true);
    expect(full.streamId).toBe('replay-tail');
    expect(full.ingest(row(ALICE, id, '1'))).toBe(true);
    expect(full.ingest(row(ALICE, id, '2'))).toBe(true);
    expect(full.ingest(row(ALICE, id, '3'))).toBe(true);
    const resumed: PositionsFrame[] = [];
    await full.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      lastSequence: 1,
      streamId: 'replay-tail',
      asOf: AS_OF,
      send: (frame) => resumed.push(frame),
    });
    expect(resumed.map((frame) => (frame.type === 'delta' ? frame.sequence : frame.type))).toEqual([2, 3]);
    expect(resumed[0]).toMatchObject({ type: 'delta', streamId: 'replay-tail', position: { contracts: '2' } });
    expect(resumed[1]).toMatchObject({ type: 'delta', streamId: 'replay-tail', position: { contracts: '3' } });
    expect(resumed.some((frame) => frame.type === 'snapshot')).toBe(false);
  });

  it('seeds a cold journal from the book port before the first snapshot', async () => {
    const stream = new PositionsStream({ streamId: 'seed-cold' });
    stream.markSourceAttached(true);
    const id = '11111111-1111-4111-8111-111111111111';
    const sent: PositionsFrame[] = [];
    const result = await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      accessToken: 'alice-token',
      seed: async (userId, accessToken) => {
        expect(userId).toBe(ALICE);
        expect(accessToken).toBe('alice-token');
        return [row(ALICE, id, '1.250000000000000001')];
      },
      send: (frame) => sent.push(frame),
    });
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channel: 'positions',
      type: 'snapshot',
      resume: 'fresh',
      streamId: 'seed-cold',
      positions: [
        expect.objectContaining({
          userId: ALICE,
          contracts: '1.250000000000000001',
          entryPrice: '64000.50',
          markPrice: '64100.5',
          fundingPaid: '-0.01',
        }),
      ],
    });
    const snap = sent[0];
    if (snap?.type !== 'snapshot') throw new Error('expected snapshot');
    expect(typeof snap.positions[0]?.contracts).toBe('string');
    expect(typeof snap.positions[0]?.entryPrice).toBe('string');
  });

  it('sends no snapshot and does not register when the book port throws', async () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const sent: PositionsFrame[] = [];
    const result = await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      accessToken: 'alice-token',
      seed: async () => {
        throw new Error('svc-trade down');
      },
      send: (frame) => sent.push(frame),
    });
    expect(result.ok).toBe(false);
    expect(sent).toEqual([
      expect.objectContaining({
        channel: 'positions',
        type: 'error',
        code: 'ws.positions_snapshot_unavailable',
      }),
    ]);
    expect(sent.some((frame) => frame.type === 'snapshot')).toBe(false);
    expect(stream.ingest(row(ALICE, '11111111-1111-4111-8111-111111111111', '1'))).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('refuses a cold snapshot when no book port is wired', async () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const sent: PositionsFrame[] = [];
    const result = await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      send: (frame) => sent.push(frame),
    });
    expect(result.ok).toBe(false);
    expect(sent).toEqual([expect.objectContaining({ type: 'error', code: 'ws.positions_snapshot_unavailable' })]);
    expect(sent.some((frame) => frame.type === 'snapshot')).toBe(false);
  });

  it('refuses an operator read of another account instead of inventing a foreign book read', async () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    let calls = 0;
    const sent: PositionsFrame[] = [];
    const result = await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read', POSITIONS_OPERATOR_SCOPE] },
      requestedUserId: BOB,
      asOf: AS_OF,
      accessToken: 'operator-token',
      seed: async () => {
        calls += 1;
        return [row(ALICE, '11111111-1111-4111-8111-111111111111', '1')];
      },
      send: (frame) => sent.push(frame),
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
    expect(sent).toEqual([expect.objectContaining({ type: 'error', code: 'ws.positions_snapshot_unavailable' })]);
    expect(sent.some((frame) => frame.type === 'snapshot')).toBe(false);
    expect(JSON.stringify(sent)).not.toContain(BOB);
  });

  it('applies events ingested during the seed read on top of the seeded rows', async () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const id = '11111111-1111-4111-8111-111111111111';
    const sent: PositionsFrame[] = [];
    await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      accessToken: 'alice-token',
      seed: async () => {
        expect(stream.ingest(row(ALICE, id, '9'))).toBe(true);
        return [row(ALICE, id, '1')];
      },
      send: (frame) => sent.push(frame),
    });
    const snap = sent[0];
    if (snap?.type !== 'snapshot') throw new Error('expected snapshot');
    expect(snap.positions).toEqual([expect.objectContaining({ contracts: '9' })]);
    expect(sent.some((frame) => frame.type === 'delta')).toBe(false);
  });

  it('sends a gap snapshot when the resume streamId is a different process', async () => {
    const streamA = new PositionsStream({ streamId: 'stream-a' });
    const streamB = new PositionsStream({ streamId: 'stream-b' });
    streamA.markSourceAttached(true);
    streamB.markSourceAttached(true);
    const id = '11111111-1111-4111-8111-111111111111';
    expect(streamA.ingest(row(ALICE, id, '1'))).toBe(true);
    expect(streamA.ingest(row(ALICE, id, '2'))).toBe(true);
    for (const contracts of ['1', '2', '3', '4', '5']) {
      expect(streamB.ingest(row(ALICE, id, contracts))).toBe(true);
    }
    const sent: PositionsFrame[] = [];
    await streamB.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      lastSequence: 2,
      streamId: streamA.streamId,
      asOf: AS_OF,
      accessToken: 'alice-token',
      seed: async () => [row(ALICE, id, '5')],
      send: (frame) => sent.push(frame),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'snapshot', resume: 'gap', streamId: 'stream-b' });
    expect(sent.some((frame) => frame.type === 'delta')).toBe(false);
  });

  it('sends a gap snapshot when lastSequence is given without a streamId', async () => {
    const stream = new PositionsStream({ streamId: 'stream-b' });
    stream.markSourceAttached(true);
    const id = '11111111-1111-4111-8111-111111111111';
    expect(stream.ingest(row(ALICE, id, '1'))).toBe(true);
    expect(stream.ingest(row(ALICE, id, '2'))).toBe(true);
    expect(stream.ingest(row(ALICE, id, '3'))).toBe(true);
    const sent: PositionsFrame[] = [];
    await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      lastSequence: 1,
      asOf: AS_OF,
      accessToken: 'alice-token',
      seed: async () => [row(ALICE, id, '3')],
      send: (frame) => sent.push(frame),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'snapshot', resume: 'gap', streamId: 'stream-b' });
    expect(sent.some((frame) => frame.type === 'delta')).toBe(false);
  });

  it('heartbeat repeats the sequence and the caller clock', async () => {
    const stream = new PositionsStream({ streamId: 'heartbeat-stream' });
    stream.markSourceAttached(true);
    const id = '11111111-1111-4111-8111-111111111111';
    stream.ingest(row(ALICE, id, '1'));
    const sent: PositionsFrame[] = [];
    await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      accessToken: 'alice-token',
      seed: async () => [row(ALICE, id, '1')],
      send: (frame) => sent.push(frame),
    });
    stream.heartbeat('2026-10-17T04:00:02.000Z');
    expect(sent.at(-1)).toEqual({
      channel: 'positions',
      type: 'heartbeat',
      streamId: 'heartbeat-stream',
      sequence: 1,
      asOf: '2026-10-17T04:00:02.000Z',
      dataAsOf: AS_OF,
    });
  });

  it('refuses an operator snapshot when the other account book was never seeded', async () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const bobId = '22222222-2222-4222-8222-222222222222';
    expect(stream.ingest(row(BOB, bobId, '2'))).toBe(true);
    let calls = 0;
    const sent: PositionsFrame[] = [];
    const result = await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read', POSITIONS_OPERATOR_SCOPE] },
      requestedUserId: BOB,
      asOf: AS_OF,
      accessToken: 'operator-token',
      seed: async () => {
        calls += 1;
        return [restOpenPosition(bobId, '2')];
      },
      send: (frame) => sent.push(frame),
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
    expect(sent).toEqual([expect.objectContaining({ type: 'error', code: 'ws.positions_snapshot_unavailable' })]);
    expect(sent.some((frame) => frame.type === 'snapshot')).toBe(false);
    expect(JSON.stringify(sent)).not.toContain(bobId);
  });

  it('sends the owner-seeded book when an operator subscribes for that account', async () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const bobId = '22222222-2222-4222-8222-222222222222';
    const owner: PositionsFrame[] = [];
    const seeded = await stream.subscribe({
      session: { userId: BOB, scopes: ['trade:read'] },
      asOf: AS_OF,
      accessToken: 'bob-token',
      seed: async () => [restOpenPosition(bobId, '2')],
      send: (frame) => owner.push(frame),
    });
    expect(seeded.ok).toBe(true);
    let operatorReads = 0;
    const allowed: PositionsFrame[] = [];
    const result = await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read', POSITIONS_OPERATOR_SCOPE] },
      requestedUserId: BOB,
      asOf: AS_OF,
      accessToken: 'operator-token',
      seed: async () => {
        operatorReads += 1;
        return [restOpenPosition(bobId, '9')];
      },
      send: (frame) => allowed.push(frame),
    });
    expect(result.ok).toBe(true);
    expect(operatorReads).toBe(0);
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({
      type: 'snapshot',
      positions: [expect.objectContaining({ userId: BOB, positionId: bobId, contracts: '2', fundingPaid: null })],
    });
  });

  it('refuses an own-account snapshot when events arrived and no seed is wired', async () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const aliceId = '11111111-1111-4111-8111-111111111111';
    expect(stream.ingest(row(ALICE, aliceId, '1'))).toBe(true);
    const sent: PositionsFrame[] = [];
    const result = await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      send: (frame) => sent.push(frame),
    });
    expect(result.ok).toBe(false);
    expect(sent).toEqual([expect.objectContaining({ type: 'error', code: 'ws.positions_snapshot_unavailable' })]);
    expect(sent.some((frame) => frame.type === 'snapshot')).toBe(false);
    expect(JSON.stringify(sent)).not.toContain(aliceId);
  });

  it('sends an empty snapshot when the open-positions read succeeds with zero rows', async () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const sent: PositionsFrame[] = [];
    const result = await stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      accessToken: 'alice-token',
      seed: async () => [],
      send: (frame) => sent.push(frame),
    });
    expect(result.ok).toBe(true);
    expect(sent).toEqual([expect.objectContaining({ type: 'snapshot', resume: 'fresh', positions: [] })]);
  });
});

describe('positions subscribe on the private socket', () => {
  let server: Server | null = null;
  let gateway: PrivateWebSocketGateway | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await gateway?.close('test');
    gateway = null;
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
  });

  async function boot(stream: PositionsStream, book?: PrivateBookPort): Promise<string> {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    gateway = createPrivateWebSocketGateway({
      authority: TEST_AUTHORITY,
      server,
      hub: new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 }),
      heartbeatMs: 60_000,
      log: { info: () => undefined, warn: () => undefined },
      enabled: () => true,
      tokens,
      positions: stream,
      ...(book ? { book } : {}),
      now: () => Date.parse(AS_OF),
    });
    return `ws://127.0.0.1:${addr.port}`;
  }

  function open(url: string): Promise<{ socket: WebSocket; frames: unknown[] }> {
    const frames: unknown[] = [];
    const socket = new WebSocket(url);
    sockets.push(socket);
    socket.on('message', (data) => {
      frames.push(JSON.parse(data.toString()));
    });
    return new Promise((resolve, reject) => {
      socket.on('open', () => resolve({ socket, frames }));
      socket.on('error', reject);
    });
  }

  it('two authenticated sessions receive only their own sequenced frames', async () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const aliceId = '11111111-1111-4111-8111-111111111111';
    const bobId = '22222222-2222-4222-8222-222222222222';
    stream.ingest(row(ALICE, aliceId, '1.5'));
    stream.ingest(row(BOB, bobId, '9'));
    const book: PrivateBookPort = {
      async listOpenOrders() {
        return [];
      },
      async listOpenPositions() {
        return [];
      },
      async readOpenPositions({ userId }) {
        if (userId === ALICE) return [row(ALICE, aliceId, '1.5')];
        if (userId === BOB) return [row(BOB, bobId, '9')];
        return [];
      },
    };
    const base = await boot(stream, book);
    const aliceToken = (await issueAccessToken({ userId: ALICE, sessionId: SESSION, scopes: ['trade:read'] }, tokens)).token;
    const bobToken = (await issueAccessToken({ userId: BOB, sessionId: SESSION, scopes: ['trade:read'] }, tokens)).token;
    const alice = await open(`${base}${PRIVATE_STREAM_PATH}?access_token=${aliceToken}&channel=positions`);
    const bob = await open(`${base}${PRIVATE_STREAM_PATH}?access_token=${bobToken}&channel=positions`);
    alice.socket.send(JSON.stringify({ op: 'subscribe', channel: 'positions' }));
    bob.socket.send(JSON.stringify({ op: 'subscribe', channel: 'positions' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const alicePositions = alice.frames.filter((frame) => (frame as { sequence?: number }).sequence !== undefined);
    const bobPositions = bob.frames.filter((frame) => (frame as { sequence?: number }).sequence !== undefined);
    expect(alicePositions[0]).toMatchObject({
      type: 'snapshot',
      sequence: 1,
      positions: [expect.objectContaining({ userId: ALICE, contracts: '1.5' })],
    });
    expect(JSON.stringify(alicePositions)).not.toContain(BOB);
    expect(bobPositions[0]).toMatchObject({
      type: 'snapshot',
      positions: [expect.objectContaining({ userId: BOB, contracts: '9' })],
    });
    expect(JSON.stringify(bobPositions)).not.toContain(ALICE);
  });

  async function shutdown(): Promise<void> {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await gateway?.close('test');
    gateway = null;
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
  }

  async function subscribePositions(fetchImpl: typeof fetch): Promise<Record<string, unknown>[]> {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const token = (await issueAccessToken({ userId: ALICE, sessionId: SESSION, scopes: ['trade:read'] }, tokens)).token;
    const book = new HttpPrivateBookPort({ baseUrl: 'http://svc-trade.test', fetch: fetchImpl });
    const base = await boot(stream, book);
    const client = await open(`${base}${PRIVATE_STREAM_PATH}?access_token=${token}&channel=orders`);
    client.socket.send(JSON.stringify({ op: 'subscribe', channel: 'positions' }));
    await waitUntil(() => positionsChannel(client.frames).length > 0);
    return positionsChannel(client.frames);
  }

  function expectRefusal(frames: Record<string, unknown>[]): void {
    expect(frames).toEqual([
      expect.objectContaining({
        channel: 'positions',
        type: 'error',
        code: 'ws.positions_snapshot_unavailable',
      }),
    ]);
    expect(frames.some((frame) => frame.type === 'snapshot')).toBe(false);
  }

  it('refuses a positions subscribe when the trade read returns HTTP 503', async () => {
    const frames = await subscribePositions(ordersOrPositionsFetch(() => new Response('unavailable', { status: 503 })));
    expectRefusal(frames);
  });

  it('refuses a positions subscribe when the trade read rejects or the body is not JSON', async () => {
    const rejected = await subscribePositions(
      ordersOrPositionsFetch(() => {
        throw new TypeError('network down');
      }),
    );
    expectRefusal(rejected);
    await shutdown();
    const invalid = await subscribePositions(
      ordersOrPositionsFetch(() => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    expectRefusal(invalid);
  });

  it('reads positions again after a failed seed instead of replaying an empty book', async () => {
    const stream = new PositionsStream({ streamId: 'seed-retry' });
    stream.markSourceAttached(true);
    const id = '11111111-1111-4111-8111-111111111111';
    let mode: 'down' | 'row' = 'down';
    const token = (await issueAccessToken({ userId: ALICE, sessionId: SESSION, scopes: ['trade:read'] }, tokens)).token;
    const book = new HttpPrivateBookPort({
      baseUrl: 'http://svc-trade.test',
      fetch: ordersOrPositionsFetch(() => {
        if (mode === 'down') return new Response('unavailable', { status: 503 });
        return new Response(JSON.stringify([restOpenPosition(id, '1.250000000000000001')]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });
    const base = await boot(stream, book);
    const client = await open(`${base}${PRIVATE_STREAM_PATH}?access_token=${token}&channel=orders`);
    client.socket.send(JSON.stringify({ op: 'subscribe', channel: 'positions' }));
    await waitUntil(() => positionsChannel(client.frames).length > 0);
    expectRefusal(positionsChannel(client.frames));
    mode = 'row';
    client.socket.send(JSON.stringify({ op: 'subscribe', channel: 'positions' }));
    await waitUntil(() => positionsChannel(client.frames).some((frame) => frame.type === 'snapshot'));
    const frames = positionsChannel(client.frames);
    expect(frames.at(-1)).toMatchObject({
      channel: 'positions',
      type: 'snapshot',
      resume: 'fresh',
      streamId: 'seed-retry',
      positions: [
        expect.objectContaining({
          userId: ALICE,
          positionId: id,
          contracts: '1.250000000000000001',
          entryPrice: '64000.50',
          fundingPaid: null,
        }),
      ],
    });
    expect(typeof (frames.at(-1) as { positions?: Array<{ contracts?: unknown }> }).positions?.[0]?.contracts).toBe('string');
  });

  it('seeds a snapshot from the trade REST position row with fundingPaid null', async () => {
    const stream = new PositionsStream({ streamId: 'rest-seed' });
    stream.markSourceAttached(true);
    const id = '11111111-1111-4111-8111-111111111111';
    const token = (await issueAccessToken({ userId: ALICE, sessionId: SESSION, scopes: ['trade:read'] }, tokens)).token;
    const book = new HttpPrivateBookPort({
      baseUrl: 'http://svc-trade.test',
      fetch: ordersOrPositionsFetch(
        () =>
          new Response(JSON.stringify([restOpenPosition(id, '1.250000000000000001')]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    });
    const base = await boot(stream, book);
    const client = await open(`${base}${PRIVATE_STREAM_PATH}?access_token=${token}&channel=orders`);
    client.socket.send(JSON.stringify({ op: 'subscribe', channel: 'positions' }));
    await waitUntil(() => positionsChannel(client.frames).length > 0);
    const frames = positionsChannel(client.frames);
    expect(frames[0]).toMatchObject({
      channel: 'positions',
      type: 'snapshot',
      resume: 'fresh',
      streamId: 'rest-seed',
      positions: [
        expect.objectContaining({
          userId: ALICE,
          positionId: id,
          contracts: '1.250000000000000001',
          entryPrice: '64000.50',
          fundingPaid: null,
        }),
      ],
    });
    expect(frames.some((frame) => frame.type === 'error')).toBe(false);
  });

  it('refuses a positions snapshot when a REST money field is a JSON number', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const frames = await subscribePositions(
      ordersOrPositionsFetch(
        () =>
          new Response(JSON.stringify([restOpenPosition(id, 1.25)]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    expectRefusal(frames);
    expect(JSON.stringify(frames)).not.toContain(id);
  });

  it('seeds two gateway sockets from the book and keeps each account on its own rows', async () => {
    const stream = new PositionsStream({ streamId: 'gateway-seed' });
    stream.markSourceAttached(true);
    const aliceId = '11111111-1111-4111-8111-111111111111';
    const bobId = '22222222-2222-4222-8222-222222222222';
    const aliceToken = (await issueAccessToken({ userId: ALICE, sessionId: SESSION, scopes: ['trade:read'] }, tokens)).token;
    const bobToken = (await issueAccessToken({ userId: BOB, sessionId: SESSION, scopes: ['trade:read'] }, tokens)).token;
    const book = new HttpPrivateBookPort({
      baseUrl: 'http://svc-trade.test',
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/v1/orders/open')) {
          return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        const id = auth === `Bearer ${bobToken}` ? bobId : aliceId;
        const contracts = auth === `Bearer ${bobToken}` ? '9' : '1.5';
        return new Response(JSON.stringify([restOpenPosition(id, contracts)]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const base = await boot(stream, book);
    const alice = await open(`${base}${PRIVATE_STREAM_PATH}?access_token=${aliceToken}&channel=orders`);
    const bob = await open(`${base}${PRIVATE_STREAM_PATH}?access_token=${bobToken}&channel=orders`);
    alice.socket.send(JSON.stringify({ op: 'subscribe', channel: 'positions' }));
    bob.socket.send(JSON.stringify({ op: 'subscribe', channel: 'positions' }));
    await waitUntil(() => positionsChannel(alice.frames).length > 0 && positionsChannel(bob.frames).length > 0);
    const alicePositions = positionsChannel(alice.frames);
    const bobPositions = positionsChannel(bob.frames);
    expect(alicePositions[0]).toMatchObject({
      type: 'snapshot',
      resume: 'fresh',
      streamId: 'gateway-seed',
      positions: [expect.objectContaining({ userId: ALICE, contracts: '1.5', entryPrice: '64000.50', fundingPaid: null })],
    });
    expect(JSON.stringify(alicePositions)).not.toContain(BOB);
    expect(JSON.stringify(alicePositions)).not.toContain(bobId);
    expect(bobPositions[0]).toMatchObject({
      type: 'snapshot',
      resume: 'fresh',
      positions: [expect.objectContaining({ userId: BOB, contracts: '9', fundingPaid: null })],
    });
    expect(JSON.stringify(bobPositions)).not.toContain(ALICE);
    expect(JSON.stringify(bobPositions)).not.toContain(aliceId);
  });

  it('refuses subscribe text when no session is supplied to the router', async () => {
    const sent: string[] = [];
    const handled = await handlePositionsSubscribeText('{"op":"subscribe","channel":"positions"}', {
      stream: new PositionsStream(),
      session: null,
      nowIso: AS_OF,
      send: (frame) => sent.push(frame),
      onDetach: () => undefined,
    });
    expect(handled).toBe(true);
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({ code: POSITIONS_UNAUTHENTICATED });
  });
});
