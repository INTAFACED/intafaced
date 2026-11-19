import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { SERVICE_HEADER, verifyServiceHeaders } from '@intafaced/contracts';
import { FIX_ADAPTER_STATUS } from '@intafaced/contracts/fix-procedures';
import { WS_SBE_CONSUMERS } from '@intafaced/contracts/ws-procedures';
import {
  ADAPTER_STATUS_EDGE_PATH,
  adapterRead,
  recordStatusRead,
  registerAdapterStatusRoute,
  type AdapterStatusDeps,
  type AdapterStatusRead,
} from './adapter-status-door.js';

const tokens: TokenConfig = {
  secret: 'edge-test-access-secret-at-least-32-chars',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const KEY = 'k'.repeat(32);

const FIX = {
  service: 'svc-fix',
  sessions: [
    {
      role: 'order-entry',
      beginString: 'FIX.4.4',
      senderCompId: 'INTAFACED',
      targetCompId: 'CLIENT',
      state: 'Not logged on',
      accountId: 'acct-1',
      nextSenderSeq: 1,
      nextTargetSeq: 1,
      // Not a named field: never passed on.
      balance: '1000',
    },
  ],
  compIdMapSet: true,
  compIdMap: [{ compId: 'CLIENT', accountId: 'acct-1' }],
  asOf: '2026-11-07T00:00:00.000Z',
};
const SBE = { service: 'svc-ws', codecLinked: false, consumers: [], asOf: '2026-11-07T00:00:00.000Z' };

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function bearer(scopes: Array<'admin:read' | 'trade:read'>): Promise<string> {
  const { token } = await issueAccessToken({ userId: OPERATOR, sessionId: SESSION, scopes, tier: 'institutional', mfa: true }, tokens);
  return `Bearer ${token}`;
}

const answering =
  (body: unknown, status = 200): AdapterStatusRead =>
  async () => ({ kind: 'answered', status, body });

function mount(over: Partial<AdapterStatusDeps> = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAdapterStatusRoute(app, {
    tokens,
    fix: answering(FIX),
    sbe: answering(SBE),
    now: () => Date.parse('2026-11-07T00:00:01Z'),
    ...over,
  });
  apps.push(app);
  return app;
}

describe('adapter status door (J-cex-spot-20 #3)', () => {
  it('needs an operator token with admin:read', async () => {
    const app = mount();
    expect((await app.inject({ method: 'GET', url: ADAPTER_STATUS_EDGE_PATH })).statusCode).toBe(401);
    const trader = await app.inject({
      method: 'GET',
      url: ADAPTER_STATUS_EDGE_PATH,
      headers: { authorization: await bearer(['trade:read']) },
    });
    expect(trader.statusCode).toBe(403);
  });

  it('carries each adapter its own status, named fields only', async () => {
    const res = await mount().inject({
      method: 'GET',
      url: ADAPTER_STATUS_EDGE_PATH,
      headers: { authorization: await bearer(['admin:read']) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fix.read).toBe('ok');
    expect(body.fix.sessions[0]).toEqual({ ...FIX.sessions[0], balance: undefined });
    expect(body.fix.sessions[0]).not.toHaveProperty('balance');
    expect(body.fix.compIdMap).toEqual(FIX.compIdMap);
    expect(body.sbe).toMatchObject({ read: 'ok', codecLinked: false, consumers: [] });
    expect(JSON.stringify(body)).not.toMatch(/balance|margin|greeks/i);
  });

  it('a blank key or a refusal is that half alone, by name', async () => {
    const blocked = adapterRead(
      'http://fix.test',
      undefined,
      {
        service: 'svc-fix',
        code: 'fix_status_unconfigured',
        urlKey: 'FIX_STATUS_URL',
        secretKey: 'FIX_STATUS_READ_SECRET',
      },
      1000,
    );
    const app = mount({ fix: blocked, sbe: answering({ ok: false, error: { code: 'ws_status_unconfigured', message: 'blank' } }, 503) });
    const body = (
      await app.inject({ method: 'GET', url: ADAPTER_STATUS_EDGE_PATH, headers: { authorization: await bearer(['admin:read']) } })
    ).json();
    expect(body.fix).toMatchObject({ read: 'refused', code: 'fix_status_unconfigured', key: 'FIX_STATUS_READ_SECRET' });
    expect(body.sbe).toMatchObject({ read: 'refused', code: 'ws_status_unconfigured' });

    const odd = mount({ fix: answering({ sessions: 'x' }), sbe: async () => ({ kind: 'unknown', error: 'late' }) });
    const oddBody = (
      await odd.inject({ method: 'GET', url: ADAPTER_STATUS_EDGE_PATH, headers: { authorization: await bearer(['admin:read']) } })
    ).json();
    expect(oddBody.fix).toMatchObject({ read: 'refused', code: 'adapter_status_unreadable' });
    expect(oddBody.sbe).toMatchObject({ read: 'unknown' });
  });

  it('signs a GET of exactly the one path as svc-edge with the read key', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const fetchFn = (async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return new Response(JSON.stringify(FIX), { status: 200 });
    }) as typeof fetch;
    const read = recordStatusRead(FIX_ADAPTER_STATUS, { baseUrl: 'http://fix.test/', secret: KEY, timeoutMs: 1000, fetchFn });
    expect(await read()).toMatchObject({ kind: 'answered', status: 200 });
    expect(seen!.url).toBe('http://fix.test/internal/status');
    expect(seen!.headers['content-type']).toBeUndefined();
    expect(seen!.headers[SERVICE_HEADER]).toBe('svc-edge');
    const verdict = verifyServiceHeaders(seen!.headers, KEY, { mode: 'require', rawBody: { retained: true, bytes: Buffer.alloc(0) } });
    expect(verdict.service).toBe('svc-edge');
  });
});

describe("svc-ws's half, through its record (WS_SBE_CONSUMERS)", () => {
  const sbeFetch = (body: string, status = 200, seen?: { url?: string; init?: RequestInit }) =>
    (async (url: string, init: RequestInit) => {
      if (seen) Object.assign(seen, { url, init });
      return new Response(body, { status });
    }) as typeof fetch;

  it('signs a bodiless GET of the record path as svc-edge with the read key, and carries the reply', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const consumer = { id: 'sbe-1', marketId: 'BTC-USD', connectedAt: '2026-11-07T00:00:00.000Z', framesSent: 2, lastSequence: '7' };
    const read = recordStatusRead(WS_SBE_CONSUMERS, {
      baseUrl: 'http://ws.test/',
      secret: KEY,
      timeoutMs: 1000,
      fetchFn: sbeFetch(JSON.stringify({ ...SBE, consumers: [consumer] }), 200, seen),
    });
    expect(await read()).toEqual({ kind: 'answered', status: 200, body: { ...SBE, consumers: [consumer] } });
    expect(seen.url).toBe('http://ws.test/internal/sbe/consumers');
    expect(seen.init?.method).toBe('GET');
    expect(seen.init?.body).toBeUndefined();
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(headers[SERVICE_HEADER]).toBe('svc-edge');
    const verdict = verifyServiceHeaders(headers, KEY, { mode: 'require', rawBody: { retained: true, bytes: Buffer.alloc(0) } });
    expect(verdict.service).toBe('svc-edge');
  });

  it("a refusal comes back with svc-ws's own status and body, and reads as that refusal by name", async () => {
    const refusal = { ok: false, error: { code: 'forbidden', message: 'the SBE consumer list is read by svc-edge only' } };
    const read = recordStatusRead(WS_SBE_CONSUMERS, {
      baseUrl: 'http://ws.test',
      secret: KEY,
      timeoutMs: 1000,
      fetchFn: sbeFetch(JSON.stringify(refusal), 403),
    });
    expect(await read()).toEqual({ kind: 'answered', status: 403, body: refusal });
    const body = (
      await mount({ sbe: read }).inject({
        method: 'GET',
        url: ADAPTER_STATUS_EDGE_PATH,
        headers: { authorization: await bearer(['admin:read']) },
      })
    ).json();
    expect(body.sbe).toEqual({ read: 'refused', code: 'forbidden', error: 'the SBE consumer list is read by svc-edge only' });
  });

  it('a reply the record does not parse, or that is not JSON, reads as unreadable', async () => {
    for (const raw of [
      JSON.stringify({ ...SBE, consumers: [{ id: '' }] }),
      JSON.stringify({ codecLinked: false, consumers: [], asOf: 'x' }),
      'not json',
    ]) {
      const read = recordStatusRead(WS_SBE_CONSUMERS, { baseUrl: 'http://ws.test', secret: KEY, timeoutMs: 1000, fetchFn: sbeFetch(raw) });
      expect(await read()).toEqual({ kind: 'answered', status: 200, body: null });
      const body = (
        await mount({ sbe: read }).inject({
          method: 'GET',
          url: ADAPTER_STATUS_EDGE_PATH,
          headers: { authorization: await bearer(['admin:read']) },
        })
      ).json();
      expect(body.sbe).toMatchObject({ read: 'refused', code: 'adapter_status_unreadable' });
    }
  });

  it('no answer is unavailable, and past the timeout unknown', async () => {
    const down = recordStatusRead(WS_SBE_CONSUMERS, {
      baseUrl: 'http://ws.test',
      secret: KEY,
      timeoutMs: 1000,
      fetchFn: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect(await down()).toEqual({ kind: 'unavailable', error: 'svc-ws did not answer: fetch failed' });
    const slow = recordStatusRead(WS_SBE_CONSUMERS, {
      baseUrl: 'http://ws.test',
      secret: KEY,
      timeoutMs: 1000,
      fetchFn: (async () => {
        throw new DOMException('late', 'TimeoutError');
      }) as typeof fetch,
    });
    expect(await slow()).toEqual({ kind: 'unknown', error: 'svc-ws did not answer before 1000ms' });
  });
});

describe("svc-fix's half, through its record (FIX_ADAPTER_STATUS)", () => {
  const fixFetch = (body: string, status = 200) => (async () => new Response(body, { status })) as typeof fetch;
  const fixRead = (fetchFn: typeof fetch) =>
    recordStatusRead(FIX_ADAPTER_STATUS, { baseUrl: 'http://fix.test', secret: KEY, timeoutMs: 1000, fetchFn });
  const shown = async (fix: AdapterStatusRead) =>
    (
      await mount({ fix }).inject({
        method: 'GET',
        url: ADAPTER_STATUS_EDGE_PATH,
        headers: { authorization: await bearer(['admin:read']) },
      })
    ).json().fix;

  it('carries the named fields only, never service or anything svc-fix adds', async () => {
    const fix = await shown(fixRead(fixFetch(JSON.stringify(FIX))));
    expect(fix.read).toBe('ok');
    expect(fix).not.toHaveProperty('service');
    expect(fix.sessions[0]).not.toHaveProperty('balance');
    expect(fix.compIdMapSet).toBe(true);
  });

  it("a refusal reads as svc-fix's own code and message; one with no JSON body as unavailable", async () => {
    const refusal = { ok: false, error: { code: 'forbidden', message: 'the adapter status is read by svc-edge only' } };
    expect(await shown(fixRead(fixFetch(JSON.stringify(refusal), 403)))).toEqual({
      read: 'refused',
      code: 'forbidden',
      error: 'the adapter status is read by svc-edge only',
    });
    const blank = { ok: false, error: { code: 'fix_status_unconfigured', message: 'FIX_STATUS_READ_SECRET is blank' } };
    expect(await shown(fixRead(fixFetch(JSON.stringify(blank), 503)))).toMatchObject({ read: 'refused', code: 'fix_status_unconfigured' });
    expect(await shown(fixRead(fixFetch('<html>', 404)))).toEqual({
      read: 'refused',
      code: 'adapter_status_unavailable',
      error: 'svc-fix answered 404',
    });
  });

  it('a reply off the record, or not JSON, reads as unreadable', async () => {
    for (const raw of [JSON.stringify({ ...FIX, compIdMapSet: 'yes' }), JSON.stringify({ ...FIX, asOf: '' }), 'not json']) {
      expect(await fixRead(fixFetch(raw))()).toEqual({ kind: 'answered', status: 200, body: null });
      expect(await shown(fixRead(fixFetch(raw)))).toMatchObject({ read: 'refused', code: 'adapter_status_unreadable' });
    }
  });

  it('no answer is unavailable, and past the timeout unknown', async () => {
    const down = fixRead((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    expect(await down()).toEqual({ kind: 'unavailable', error: 'svc-fix did not answer: fetch failed' });
    const slow = fixRead((async () => {
      throw new DOMException('late', 'TimeoutError');
    }) as typeof fetch);
    expect(await slow()).toEqual({ kind: 'unknown', error: 'svc-fix did not answer before 1000ms' });
  });
});
