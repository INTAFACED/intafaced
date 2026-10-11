import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SERVICE_BODY_DIGEST_HEADER,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  SERVICE_TIMESTAMP_HEADER,
  verifyServiceHeaders,
} from '@intafaced/contracts';
import { cancelKillParentMatching, MATCHING_SERVICE_NAME } from './oms-kill-parent-matching.js';
import { killLiveAlgoParent } from './oms-kill-parent.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { InMemoryAlgoPauseStore } from './oms-pause.js';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParent, type RetainedAlgoSchedule } from './oms-start.js';

const CHILD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORIGINATOR = '55555555-5555-4555-8555-555555555555';
const OP = '33333333-3333-4333-8333-333333333333';
const SERVICE_SECRET = 'a'.repeat(32);

type Recorded = { method: string; url: string; body: string; headers: IncomingHttpHeaders };
let server: Server | undefined;
const recorded: Recorded[] = [];

afterEach(async () => {
  recorded.length = 0;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function capture(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): Promise<void> {
  const text = await readBody(req);
  recorded.push({ method: req.method ?? '', url: req.url ?? '', body: text, headers: req.headers });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function liveAuth(matchingUrl: string) {
  return { matchingUrl, internalServiceSecret: SERVICE_SECRET };
}

function retainedTwap(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function liveParent(): ApprovedAlgoParent {
  return {
    parentClientOrderId: 'parent-twap',
    kind: 'twap',
    status: 'running',
    startedAt: '2026-08-25T00:00:00.000Z',
    residual: { remaining: '10' },
    originator: ORIGINATOR,
    schedule: retainedTwap(),
  };
}

describe('cancelKillParentMatching — unknown ≠ killed', () => {
  it('matching 404 (never saw) is unknown — not killed from silence', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 404, { cancelled: false });
    });
    const out = await cancelKillParentMatching({
      ...liveAuth(matchingUrl),
      children: [{ marketId: 'BTC-USDT', orderId: CHILD }],
    });
    expect(out).toMatchObject({ ok: true, killed: false });
    if (!out.ok) return;
    expect(out.children[0]).toMatchObject({ outcome: 'unknown', reason: 'matching_unknown' });
    expect(recorded.map((r) => ({ method: r.method, url: r.url }))).toEqual([
      { method: 'DELETE', url: `/markets/BTC-USDT/orders/${CHILD}` },
    ]);
  });

  it('cancelled true without sequence is unknown — cancel is a request until matching sequence', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 200, { cancelled: true, orderId: CHILD });
    });
    const out = await cancelKillParentMatching({
      ...liveAuth(matchingUrl),
      children: [{ marketId: 'BTC-USDT', orderId: CHILD }],
    });
    expect(out).toMatchObject({ ok: true, killed: false });
    if (!out.ok) return;
    expect(out.children[0]).toMatchObject({ outcome: 'unknown', reason: 'matching_unknown' });
  });

  it('cancelled true with sequence is killed true', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 200, { cancelled: true, sequence: 9, orderId: CHILD });
    });
    const out = await cancelKillParentMatching({
      ...liveAuth(matchingUrl),
      children: [{ marketId: 'BTC-USDT', orderId: CHILD }],
    });
    expect(out).toEqual({
      ok: true,
      killed: true,
      children: [{ clientOrderId: CHILD, venueId: 'BTC-USDT', outcome: 'stopped', status: 'canceled' }],
    });
  });

  it('signs matching DELETEs with v2 svc-execution service-auth headers', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 200, { cancelled: true, sequence: 9, orderId: CHILD });
    });
    const out = await cancelKillParentMatching({
      ...liveAuth(matchingUrl),
      children: [{ marketId: 'BTC-USDT', orderId: CHILD }],
    });
    expect(out).toMatchObject({ ok: true, killed: true });
    expect(recorded).toHaveLength(1);
    const hit = recorded[0]!;
    expect(hit.headers[SERVICE_HEADER]).toBe(MATCHING_SERVICE_NAME);
    expect(hit.headers[SERVICE_BODY_DIGEST_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(hit.headers[SERVICE_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(hit.headers[SERVICE_TIMESTAMP_HEADER]).toMatch(/^\d+$/);
    expect(
      verifyServiceHeaders(hit.headers, SERVICE_SECRET, {
        rawBody: { retained: true, bytes: Buffer.from(hit.body, 'utf8') },
        mode: 'require',
      }),
    ).toEqual({ service: MATCHING_SERVICE_NAME, rejected: null, scheme: 'v2' });
  });

  it('marketId "." or ".." refuses missing_market and does not fetch', async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ cancelled: true, sequence: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const matchingUrl = 'http://matching.test';

    for (const marketId of ['..', '.', ' .. ', ' . ']) {
      calls.length = 0;
      const out = await cancelKillParentMatching({
        matchingUrl,
        internalServiceSecret: SERVICE_SECRET,
        fetch: fetchFn,
        children: [{ marketId, orderId: CHILD }],
      });
      expect(out).toMatchObject({ ok: false, reason: 'missing_market' });
      expect(calls).toEqual([]);
    }

    calls.length = 0;
    const out = await cancelKillParentMatching({
      matchingUrl,
      internalServiceSecret: SERVICE_SECRET,
      fetch: fetchFn,
      children: [{ marketId: 'BTC-USDT', orderId: CHILD }],
    });
    expect(calls).toEqual([`${matchingUrl}/markets/BTC-USDT/orders/${CHILD}`]);
    expect(out).toMatchObject({
      ok: true,
      killed: true,
      children: [{ clientOrderId: CHILD, venueId: 'BTC-USDT', outcome: 'stopped', status: 'canceled' }],
    });
  });

  it('blank INTERNAL_SERVICE_SECRET refuses matching_service_auth_unconfigured — no unsigned DELETE', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 200, { cancelled: true, sequence: 1, orderId: CHILD });
    });
    const out = await cancelKillParentMatching({
      matchingUrl,
      internalServiceSecret: '',
      children: [{ marketId: 'BTC-USDT', orderId: CHILD }],
    });
    expect(out).toMatchObject({ ok: false, reason: 'matching_service_auth_unconfigured' });
    if (out.ok) return;
    expect(out.detail).toContain('unsigned');
    expect(recorded).toHaveLength(0);
  });
});

describe('killLiveAlgoParent matching never-saw', () => {
  it('parent matching never saw → killed false, parent stays running', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(liveParent());
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 404, { cancelled: false });
    });
    const out = await killLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      pauseStore: new InMemoryAlgoPauseStore(),
      emsStore: new InMemoryEmsOrderStore(),
      matchingUrl,
      internalServiceSecret: SERVICE_SECRET,
      matchingChildren: [{ marketId: 'BTC-USDT', orderId: CHILD }],
    });
    expect(out).toMatchObject({ ok: true, killed: false });
    if (!out.ok) return;
    expect(out.children[0]).toMatchObject({ outcome: 'unknown', reason: 'matching_unknown' });
    expect(parentStore.get('parent-twap')?.status).toBe('running');
  });

  it('matching sequence stops the parent', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(liveParent());
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 200, { cancelled: true, sequence: 4, orderId: CHILD });
    });
    const out = await killLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      pauseStore: new InMemoryAlgoPauseStore(),
      emsStore: new InMemoryEmsOrderStore(),
      matchingUrl,
      internalServiceSecret: SERVICE_SECRET,
      matchingChildren: [{ marketId: 'BTC-USDT', orderId: CHILD }],
    });
    expect(out).toMatchObject({ ok: true, killed: true });
    expect(parentStore.get('parent-twap')?.status).toBe('stopped');
  });
});
