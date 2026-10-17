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
  it('gives each account only its own snapshot and decimal-string deltas', () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const aliceId = '11111111-1111-4111-8111-111111111111';
    const bobId = '22222222-2222-4222-8222-222222222222';
    expect(stream.ingest(row(ALICE, aliceId, '1.250000000000000001'))).toBe(true);
    expect(stream.ingest(row(BOB, bobId, '2'))).toBe(true);
    expect(stream.ingest(row(ALICE, aliceId, 1.25))).toBe(false);

    const alice: PositionsFrame[] = [];
    const bob: PositionsFrame[] = [];
    stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      send: (frame) => alice.push(frame),
    });
    stream.subscribe({
      session: { userId: BOB, scopes: ['trade:read'] },
      asOf: AS_OF,
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

  it('refuses an unauthenticated subscribe and a session without admin:read asking for another account', () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    stream.ingest(row(BOB, '22222222-2222-4222-8222-222222222222', '2'));
    const anon: PositionsFrame[] = [];
    const refused = stream.subscribe({ session: null, asOf: AS_OF, send: (frame) => anon.push(frame) });
    expect(refused.ok).toBe(false);
    expect(anon).toEqual([expect.objectContaining({ type: 'error', code: POSITIONS_UNAUTHENTICATED })]);

    const foreign: PositionsFrame[] = [];
    stream.subscribe({
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

    const allowed: PositionsFrame[] = [];
    stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read', POSITIONS_OPERATOR_SCOPE] },
      requestedUserId: BOB,
      asOf: AS_OF,
      send: (frame) => allowed.push(frame),
    });
    expect(allowed[0]).toMatchObject({ type: 'snapshot', positions: [expect.objectContaining({ userId: BOB })] });
  });

  it('refuses the stream shape when positionUpdated is not attached', () => {
    const stream = new PositionsStream();
    const sent: PositionsFrame[] = [];
    stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      send: (frame) => sent.push(frame),
    });
    expect(sent).toEqual([expect.objectContaining({ type: 'error', code: POSITIONS_SOURCE_UNAVAILABLE })]);
    expect(sent.some((frame) => frame.type === 'snapshot')).toBe(false);
    expect(stream.ingest(row(ALICE, '11111111-1111-4111-8111-111111111111', '1'))).toBe(false);
  });

  it('detects a retained-sequence gap and a resume fills a contiguous tail', () => {
    const stream = new PositionsStream({ retain: 1 });
    stream.markSourceAttached(true);
    const id = '11111111-1111-4111-8111-111111111111';
    expect(stream.ingest(row(ALICE, id, '1'))).toBe(true);
    expect(stream.ingest(row(ALICE, id, '2'))).toBe(true);
    expect(stream.ingest(row(ALICE, id, '3'))).toBe(true);

    const gapped: PositionsFrame[] = [];
    stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      lastSequence: 1,
      asOf: '2026-10-17T04:00:05.000Z',
      send: (frame) => gapped.push(frame),
    });
    expect(gapped).toHaveLength(1);
    expect(gapped[0]).toMatchObject({ type: 'snapshot', sequence: 3, resume: 'gap' });
    expect(gapped.some((frame) => frame.type === 'delta')).toBe(false);

    const full = new PositionsStream();
    full.markSourceAttached(true);
    expect(full.ingest(row(ALICE, id, '1'))).toBe(true);
    expect(full.ingest(row(ALICE, id, '2'))).toBe(true);
    expect(full.ingest(row(ALICE, id, '3'))).toBe(true);
    const resumed: PositionsFrame[] = [];
    full.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      lastSequence: 1,
      asOf: AS_OF,
      send: (frame) => resumed.push(frame),
    });
    expect(resumed.map((frame) => (frame.type === 'delta' ? frame.sequence : frame.type))).toEqual([2, 3]);
    expect(resumed[0]).toMatchObject({ type: 'delta', position: { contracts: '2' } });
    expect(resumed[1]).toMatchObject({ type: 'delta', position: { contracts: '3' } });
  });

  it('heartbeat repeats the sequence and the caller clock', () => {
    const stream = new PositionsStream();
    stream.markSourceAttached(true);
    const id = '11111111-1111-4111-8111-111111111111';
    stream.ingest(row(ALICE, id, '1'));
    const sent: PositionsFrame[] = [];
    stream.subscribe({
      session: { userId: ALICE, scopes: ['trade:read'] },
      asOf: AS_OF,
      send: (frame) => sent.push(frame),
    });
    stream.heartbeat('2026-10-17T04:00:02.000Z');
    expect(sent.at(-1)).toEqual({
      channel: 'positions',
      type: 'heartbeat',
      sequence: 1,
      asOf: '2026-10-17T04:00:02.000Z',
      dataAsOf: AS_OF,
    });
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

  async function boot(stream: PositionsStream): Promise<string> {
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
    const base = await boot(stream);
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
