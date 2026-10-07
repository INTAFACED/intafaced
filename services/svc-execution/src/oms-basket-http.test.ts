import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { handleKillBasketDoor, handleStartBasketDoor, registerStartBasketDoor } from './oms-basket-http.js';
import { createExecutionRouter } from './router.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';

const OP = '33333333-3333-4333-8333-333333333333';
const SECRET = 'a-execution-oms-basket-http-test-edge-secret';
const SERVICE_SECRET = 'a'.repeat(32);
const PREV_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET;
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });
const MATCHING_OPEN = { venueHalted: false } as const;
const JOBS_ON = { enabled: true } as const;
const BTC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ETH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function proofFor(marketId: string) {
  const observedAt = '2026-09-01T12:00:00.000Z';
  return createMarketLifecycleAdmissionProof(
    {
      marketId,
      ruleVersion: 'test.rules.v1',
      instrumentId: marketId,
      instrumentVersion: 'test.instrument.v1',
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: observedAt,
      observedAt,
      lastGoodState: 'OPEN',
      allowedActions: ['PLACE', 'PLACE_POST_ONLY'],
      transitionId: 'test.transition',
      evidenceRefs: ['test.evidence'],
    },
    'PLACE',
  );
}

const LEGS = [
  {
    name: 'BTC',
    qty: '0.5',
    marketId: 'BTC-USDT',
    orderId: BTC_ID,
    side: 'buy' as const,
    type: 'limit' as const,
    tif: 'GTC' as const,
    price: '100.25',
    accountId: 'acct-desk',
    lifecycleProof: proofFor('BTC-USDT'),
  },
  {
    name: 'ETH',
    qty: '2',
    marketId: 'ETH-USDT',
    orderId: ETH_ID,
    side: 'sell' as const,
    type: 'limit' as const,
    tif: 'GTC' as const,
    price: '10',
    accountId: 'acct-desk',
    lifecycleProof: proofFor('ETH-USDT'),
  },
] as const;

const BODY = {
  parentClientOrderId: 'p-basket',
  kind: 'basket' as const,
  approved: true,
  legs: [...LEGS],
  partialFailurePolicy: 'refuse_all',
  credit: '100',
  remaining: '1.25',
};

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: OP,
    userId: OP,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function hmacHeaders(payload: unknown, service = 'svc-execution') {
  const body = JSON.stringify(payload);
  return {
    'content-type': 'application/json',
    ...serviceAuthHeadersForBody(service, SERVICE_SECRET, body),
  };
}

function hmacCtx(id: string) {
  return { ...edgeContext({ headers: signedHeaders(), id }), service: 'svc-execution' as const };
}

type Recorded = { method: string; url: string; body: string };
let server: Server | undefined;
const recorded: Recorded[] = [];

beforeEach(() => {
  process.env.INTERNAL_SERVICE_SECRET = SERVICE_SECRET;
});

afterEach(async () => {
  recorded.length = 0;
  if (PREV_SERVICE_SECRET === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
  else process.env.INTERNAL_SERVICE_SECRET = PREV_SERVICE_SECRET;
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
  recorded.push({ method: req.method ?? '', url: req.url ?? '', body: text });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

describe('handleStartBasketDoor', () => {
  it('happy path: children POST matching with ledger qty strings, not paper, no fills', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 200, { accepted: true, sequence: 3 });
    });
    const out = await handleStartBasketDoor(BODY, OP, {
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      matchingUrl,
    });
    expect(out).toMatchObject({
      ok: true,
      started: true,
      parentClientOrderId: 'p-basket',
      kind: 'basket',
      status: 'running',
      partialFailurePolicy: 'refuse_all',
    });
    if (!out.ok) return;
    expect(out.legs).toEqual([
      { name: 'BTC', qty: formatAmount(parseAmount('0.5')) },
      { name: 'ETH', qty: formatAmount(parseAmount('2')) },
    ]);
    expect('children' in out && out.children).toEqual([
      {
        name: 'BTC',
        qty: formatAmount(parseAmount('0.5')),
        marketId: 'BTC-USDT',
        orderId: BTC_ID,
        matching: { accepted: true, sequence: 3 },
      },
      {
        name: 'ETH',
        qty: formatAmount(parseAmount('2')),
        marketId: 'ETH-USDT',
        orderId: ETH_ID,
        matching: { accepted: true, sequence: 3 },
      },
    ]);
    expect(recorded.map((r) => r.method)).toEqual(['POST', 'POST']);
    expect(JSON.parse(recorded[0]?.body ?? '{}').qty).toBe(formatAmount(parseAmount('0.5')));
    expect(out).not.toHaveProperty('paper');
    expect(out).not.toHaveProperty('fills');
  });

  it('a later refused leg kills children already accepted — they do not keep working while the door reports failure', async () => {
    const working = new Set<string>();
    const matchingUrl = await listen(async (req, res) => {
      const text = await readBody(req);
      const method = req.method ?? '';
      const url = req.url ?? '';
      recorded.push({ method, url, body: text });
      if (method === 'POST') {
        const posts = recorded.filter((row) => row.method === 'POST').length;
        if (posts === 1) {
          const body = JSON.parse(text) as { orderId?: string };
          if (body.orderId) working.add(body.orderId);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, sequence: 1 }));
          return;
        }
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: false }));
        return;
      }
      if (method === 'DELETE') {
        const orderId = decodeURIComponent(url.split('/').pop() ?? '');
        working.delete(orderId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cancelled: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const out = await handleStartBasketDoor(BODY, OP, {
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      matchingUrl,
    });
    expect(out).toMatchObject({ ok: false, reason: 'matching_rejected' });
    expect(working).toEqual(new Set());
    expect(recorded.map((row) => row.method)).toEqual(['POST', 'POST', 'DELETE']);
    expect(recorded[2]?.url).toBe(`/markets/BTC-USDT/orders/${BTC_ID}`);
    expect(recorded.some((row) => row.url.includes(ETH_ID) && row.method === 'DELETE')).toBe(false);
  });

  it('an unconfirmed kill (HTTP 503) is not a successful start and names the child that was not killed', async () => {
    const working = new Set<string>();
    const matchingUrl = await listen(async (req, res) => {
      const text = await readBody(req);
      const method = req.method ?? '';
      const url = req.url ?? '';
      recorded.push({ method, url, body: text });
      if (method === 'POST') {
        const posts = recorded.filter((row) => row.method === 'POST').length;
        if (posts === 1) {
          const body = JSON.parse(text) as { orderId?: string };
          if (body.orderId) working.add(body.orderId);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, sequence: 1 }));
          return;
        }
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: false }));
        return;
      }
      if (method === 'DELETE') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cancelled: true, orderId: 'invented-order' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const out = await handleStartBasketDoor(BODY, OP, {
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      matchingUrl,
    });
    expect(working).toEqual(new Set([BTC_ID]));
    expect(out).toEqual({
      ok: false,
      reason: 'kill_unconfirmed',
      detail: `unconfirmed kill is not a successful start; not killed: BTC-USDT ${BTC_ID}`,
      children: [
        {
          marketId: 'BTC-USDT',
          orderId: BTC_ID,
          outcome: 'unknown',
          reason: 'cancel_failed',
        },
      ],
    });
    expect(out).not.toMatchObject({ reason: 'matching_rejected' });
    expect(JSON.stringify(out)).not.toContain('invented-order');
    expect(recorded.map((row) => row.method)).toEqual(['POST', 'POST', 'DELETE']);
    expect(recorded[2]?.url).toBe(`/markets/BTC-USDT/orders/${BTC_ID}`);
  });

  it('a confirmed already_stopped kill may return the later-leg refusal', async () => {
    const working = new Set<string>();
    const matchingUrl = await listen(async (req, res) => {
      const text = await readBody(req);
      const method = req.method ?? '';
      const url = req.url ?? '';
      recorded.push({ method, url, body: text });
      if (method === 'POST') {
        const posts = recorded.filter((row) => row.method === 'POST').length;
        if (posts === 1) {
          const body = JSON.parse(text) as { orderId?: string };
          if (body.orderId) working.add(body.orderId);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, sequence: 1 }));
          return;
        }
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: false }));
        return;
      }
      if (method === 'DELETE') {
        const orderId = decodeURIComponent(url.split('/').pop() ?? '');
        working.delete(orderId);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cancelled: false }));
        return;
      }
      res.writeHead(500);
      res.end();
    });
    const out = await handleStartBasketDoor(BODY, OP, {
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      matchingUrl,
    });
    expect(out).toMatchObject({ ok: false, reason: 'matching_rejected' });
    expect(working).toEqual(new Set());
    expect(recorded[2]?.method).toBe('DELETE');
    expect(recorded[2]?.url).toBe(`/markets/BTC-USDT/orders/${BTC_ID}`);
  });

  it('a first-leg refusal with no accepted child does not kill', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 400, { accepted: false });
    });
    const out = await handleStartBasketDoor(BODY, OP, {
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      matchingUrl,
    });
    expect(out).toMatchObject({ ok: false, reason: 'matching_rejected' });
    expect(recorded.map((row) => row.method)).toEqual(['POST']);
  });

  it('paper flag refuses before matching POST — no ledger', async () => {
    const out = await handleStartBasketDoor({ ...BODY, paper: true }, OP, {
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      matchingUrl: 'http://matching.example',
    });
    expect(out).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    expect(recorded).toHaveLength(0);
  });

  it('blank MATCHING_URL refuses matching_unconfigured', async () => {
    const out = await handleStartBasketDoor(BODY, OP, {
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
    });
    expect(out).toMatchObject({ ok: false, reason: 'matching_unconfigured' });
  });

  it('blank qty / flatten_remaining refuse — no silent drop of legs', async () => {
    expect(
      await handleStartBasketDoor({ ...BODY, legs: [{ name: 'BTC', qty: '   ' }] }, OP, {
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      await handleStartBasketDoor({ ...BODY, partialFailurePolicy: 'flatten_remaining' }, OP, {
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
      }),
    ).toMatchObject({ ok: false, reason: 'flatten_remaining_refused' });
  });

  it('twap is not_live — generic live slice stays the twap hitch, not a second basket slice', async () => {
    expect(
      await handleStartBasketDoor({ ...BODY, kind: 'twap', parentClientOrderId: 'p-twap' }, OP, {
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('body operatorId is ignored — caller operator is used', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 200, { accepted: true, sequence: 1 });
    });
    const out = await handleStartBasketDoor({ ...BODY, operatorId: '44444444-4444-4444-8444-444444444444' }, OP, {
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      matchingUrl,
    });
    expect(out).toMatchObject({ ok: true, started: true });
  });
});

describe('handleKillBasketDoor', () => {
  it('unknown matching cancel is killed false', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 503, { cancelled: false });
    });
    const out = await handleKillBasketDoor({ children: [{ marketId: 'BTC-USDT', orderId: BTC_ID }] }, { matchingUrl });
    expect(out).toMatchObject({ ok: true, killed: false });
    if (!out.ok) return;
    expect(out.children[0]).toMatchObject({ outcome: 'unknown' });
  });
});

describe('POST /execution/oms/start-basket', () => {
  async function app(matchingUrl?: string) {
    const f = Fastify();
    installOmsWriteRawBody(f);
    registerStartBasketDoor(f, {
      edgeContext,
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      matchingUrl,
      internalSecret: SERVICE_SECRET,
    });
    await f.ready();
    return f;
  }

  it('refuses anonymous start', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/execution/oms/start-basket', payload: BODY });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });

  it('session-only admin:write is 401 — HMAC required', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/start-basket',
      headers: signedHeaders(),
      payload: BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });

  it('svc-trade HMAC is 403 — must not impersonate', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/start-basket',
      headers: hmacHeaders(BODY, 'svc-trade'),
      payload: JSON.stringify(BODY),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    await f.close();
  });

  it('svc-execution HMAC starts a basket and POSTs children to matching', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 200, { accepted: true, sequence: 2 });
    });
    const f = await app(matchingUrl);
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/start-basket',
      headers: { ...signedHeaders(), ...hmacHeaders(BODY) },
      payload: JSON.stringify(BODY),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      started: true,
      kind: 'basket',
      partialFailurePolicy: 'refuse_all',
    });
    expect(res.json().children).toHaveLength(2);
    expect(recorded).toHaveLength(2);
    await f.close();
  });

  it('HTTP 503 on cancel is not a successful start and names the child that was not killed', async () => {
    const matchingUrl = await listen(async (req, res) => {
      const text = await readBody(req);
      const method = req.method ?? '';
      recorded.push({ method, url: req.url ?? '', body: text });
      if (method === 'POST') {
        const posts = recorded.filter((row) => row.method === 'POST').length;
        if (posts === 1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, sequence: 1 }));
          return;
        }
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: false }));
        return;
      }
      if (method === 'DELETE') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cancelled: true, orderId: 'invented-order' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const f = await app(matchingUrl);
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/start-basket',
      headers: { ...signedHeaders(), ...hmacHeaders(BODY) },
      payload: JSON.stringify(BODY),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: false,
      reason: 'kill_unconfirmed',
      detail: `unconfirmed kill is not a successful start; not killed: BTC-USDT ${BTC_ID}`,
      children: [
        {
          marketId: 'BTC-USDT',
          orderId: BTC_ID,
          outcome: 'unknown',
          reason: 'cancel_failed',
        },
      ],
    });
    expect(res.json()).not.toMatchObject({ reason: 'matching_rejected' });
    expect(res.body).not.toContain('invented-order');
    await f.close();
  });

  it('signed kill-basket unknown is killed false', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 504, { cancelled: false });
    });
    const f = await app(matchingUrl);
    const killBody = { children: [{ marketId: 'BTC-USDT', orderId: BTC_ID }] };
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/kill-basket',
      headers: hmacHeaders(killBody),
      payload: JSON.stringify(killBody),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, killed: false });
    await f.close();
  });
});

function basketCaller(matchingUrl?: string) {
  return createExecutionRouter(
    new SealedHouseTenantRegistry(),
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    JOBS_ON,
    { enabled: false },
    undefined,
    undefined,
    undefined,
    MATCHING_OPEN,
    matchingUrl,
  ).createCaller(hmacCtx('req-trpc-basket'));
}

describe('tRPC execution.oms.startBasket', () => {
  it('refuses anonymous startBasket', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.startBasket(BODY)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('session-only admin:write cannot startBasket', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const session = edgeContext({ headers: signedHeaders(), id: 'req-session' });
    await expect(router.createCaller(session).execution.oms.startBasket(BODY)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('svc-trade HMAC cannot startBasket', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const trade = { ...edgeContext({ headers: signedHeaders(), id: 'req-trade' }), service: 'svc-trade' };
    await expect(router.createCaller(trade).execution.oms.startBasket(BODY)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('happy path: same handleStartBasketDoor as HTTP — children POST matching, ledger qty strings', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 200, { accepted: true, sequence: 4 });
    });
    const out = await basketCaller(matchingUrl).execution.oms.startBasket(BODY);
    expect(out).toMatchObject({
      ok: true,
      started: true,
      parentClientOrderId: 'p-basket',
      kind: 'basket',
      partialFailurePolicy: 'refuse_all',
    });
    if (!out.ok) return;
    expect('children' in out && out.children).toHaveLength(2);
    expect(JSON.parse(recorded[0]?.body ?? '{}').qty).toBe(formatAmount(parseAmount('0.5')));
    expect(out).not.toHaveProperty('fills');
  });

  it('tRPC startBasket HTTP 503 on cancel is not a successful start and names the child that was not killed', async () => {
    const matchingUrl = await listen(async (req, res) => {
      const text = await readBody(req);
      const method = req.method ?? '';
      recorded.push({ method, url: req.url ?? '', body: text });
      if (method === 'POST') {
        const posts = recorded.filter((row) => row.method === 'POST').length;
        if (posts === 1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, sequence: 1 }));
          return;
        }
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: false }));
        return;
      }
      if (method === 'DELETE') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cancelled: true, orderId: 'invented-order' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const out = await basketCaller(matchingUrl).execution.oms.startBasket(BODY);
    expect(out).toEqual({
      ok: false,
      reason: 'kill_unconfirmed',
      detail: `unconfirmed kill is not a successful start; not killed: BTC-USDT ${BTC_ID}`,
      children: [
        {
          marketId: 'BTC-USDT',
          orderId: BTC_ID,
          outcome: 'unknown',
          reason: 'cancel_failed',
        },
      ],
    });
    expect(out).not.toMatchObject({ reason: 'matching_rejected' });
    expect(JSON.stringify(out)).not.toContain('invented-order');
  });

  it('paper flag refuses before matching POST — no ledger', async () => {
    const out = await basketCaller('http://matching.example').execution.oms.startBasket({ ...BODY, paper: true });
    expect(out).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    expect(recorded).toHaveLength(0);
  });
});

describe('tRPC execution.oms.killBasket', () => {
  it('refuses anonymous killBasket', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(
      router.createCaller(anon).execution.oms.killBasket({
        children: [{ marketId: 'BTC-USDT', orderId: BTC_ID }],
      }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('session-only admin:write cannot killBasket', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const session = edgeContext({ headers: signedHeaders(), id: 'req-session-kill' });
    await expect(
      router.createCaller(session).execution.oms.killBasket({
        children: [{ marketId: 'BTC-USDT', orderId: BTC_ID }],
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('unknown matching cancel is killed false — same handleKillBasketDoor as HTTP', async () => {
    const matchingUrl = await listen(async (req, res) => {
      await capture(req, res, 504, { cancelled: false });
    });
    const out = await basketCaller(matchingUrl).execution.oms.killBasket({
      children: [{ marketId: 'BTC-USDT', orderId: BTC_ID }],
    });
    expect(out).toMatchObject({ ok: true, killed: false });
    if (!out.ok) return;
    expect(out.children[0]).toMatchObject({ outcome: 'unknown' });
    expect(recorded.map((r) => r.method)).toEqual(['DELETE']);
  });
});
