import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { SERVICE_HEADER, verifyServiceHeaders } from '@intafaced/contracts';
import {
  ADAPTER_STATUS_EDGE_PATH,
  fixAdapterRead,
  fixStatusRead,
  httpAdapterStatusRead,
  registerAdapterStatusRoute,
  type AdapterStatusDeps,
  type AdapterStatusRead,
  type SbeStatus,
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

/** A fetch that answers every call with this body and status, keeping each request it was sent. */
function answering(body: unknown, status = 200, seen: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}
const fixRead = (fetchFn: typeof fetch) => fixStatusRead({ baseUrl: 'http://fix.test', secret: KEY, timeoutMs: 1000, fetcher: fetchFn });
const sbeOk: AdapterStatusRead<SbeStatus> = async () => ({ read: 'ok', codecLinked: false, consumers: [], asOf: SBE.asOf });

function mount(over: Partial<AdapterStatusDeps> = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAdapterStatusRoute(app, {
    tokens,
    fix: fixRead(answering(FIX)),
    sbe: sbeOk,
    now: () => Date.parse('2026-11-07T00:00:01Z'),
    ...over,
  });
  apps.push(app);
  return app;
}

async function read(app: FastifyInstance) {
  return (
    await app.inject({ method: 'GET', url: ADAPTER_STATUS_EDGE_PATH, headers: { authorization: await bearer(['admin:read']) } })
  ).json();
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
    expect(body.fix).not.toHaveProperty('service');
    expect(body.fix.compIdMap).toEqual(FIX.compIdMap);
    expect(body.sbe).toMatchObject({ read: 'ok', codecLinked: false, consumers: [] });
    expect(JSON.stringify(body)).not.toMatch(/balance|margin|greeks/i);
  });

  it('a blank key or a refusal is that half alone, by name', async () => {
    const blocked = fixAdapterRead('http://fix.test', undefined, { timeoutMs: 1000 });
    const sbeRefused: AdapterStatusRead<SbeStatus> = async () => ({ read: 'refused', code: 'ws_status_unconfigured', error: 'blank' });
    const body = await read(mount({ fix: blocked, sbe: sbeRefused }));
    expect(body.fix).toMatchObject({ read: 'refused', code: 'fix_status_unconfigured', key: 'FIX_STATUS_READ_SECRET' });
    expect(body.sbe).toMatchObject({ read: 'refused', code: 'ws_status_unconfigured' });
    expect(fixAdapterRead(undefined, KEY, { timeoutMs: 1000 })).toEqual({ code: 'fix_status_unconfigured', key: 'FIX_STATUS_URL' });

    const oddBody = await read(
      mount({
        fix: fixRead(answering({ sessions: 'x' })),
        sbe: async () => ({ read: 'unknown', code: 'adapter_status_unknown', error: 'late' }),
      }),
    );
    expect(oddBody.fix).toMatchObject({ read: 'refused', code: 'adapter_status_unreadable' });
    expect(oddBody.sbe).toMatchObject({ read: 'unknown' });
  });

  it("svc-fix's own refusal, a non-JSON answer, a timeout and a dead socket each read by name", async () => {
    const refusal = { ok: false, error: { code: 'forbidden', message: 'the adapter status is read by svc-edge only' } };
    expect((await read(mount({ fix: fixRead(answering(refusal, 403)) }))).fix).toEqual({
      read: 'refused',
      code: 'forbidden',
      error: 'the adapter status is read by svc-edge only',
    });
    expect((await read(mount({ fix: fixRead(answering('<html>', 404)) }))).fix).toEqual({
      read: 'refused',
      code: 'adapter_status_unavailable',
      error: 'svc-fix answered 404',
    });
    expect((await read(mount({ fix: fixRead(answering('not json', 200)) }))).fix).toMatchObject({
      read: 'refused',
      code: 'adapter_status_unreadable',
    });
    const late = (async () => {
      throw new DOMException('late', 'TimeoutError');
    }) as typeof fetch;
    expect((await read(mount({ fix: fixRead(late) }))).fix).toEqual({
      read: 'unknown',
      code: 'adapter_status_unknown',
      error: 'svc-fix did not answer before 1000ms',
    });
    const dead = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect((await read(mount({ fix: fixRead(dead) }))).fix).toEqual({
      read: 'refused',
      code: 'adapter_status_unavailable',
      error: 'svc-fix did not answer: fetch failed',
    });
  });

  it("GETs svc-fix's one recorded path, no body and no content type, signed as svc-edge with the read key", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    expect(await fixRead(answering(FIX, 200, seen))()).toMatchObject({ read: 'ok' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://fix.test/internal/status');
    expect(seen[0]!.init.method).toBe('GET');
    expect(seen[0]!.init.body).toBeUndefined();
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('content-type');
    expect(headers[SERVICE_HEADER]).toBe('svc-edge');
    const verdict = verifyServiceHeaders(headers, KEY, { mode: 'require', rawBody: { retained: true, bytes: Buffer.alloc(0) } });
    expect(verdict.service).toBe('svc-edge');
  });

  it('signs a GET of exactly the one path as svc-edge with the read key', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const fetchFn = (async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return new Response(JSON.stringify(SBE), { status: 200 });
    }) as typeof fetch;
    const read = httpAdapterStatusRead('http://ws.test/', '/internal/sbe/consumers', KEY, 1000, 'svc-ws', fetchFn);
    expect(await read()).toMatchObject({ kind: 'answered', status: 200 });
    expect(seen!.url).toBe('http://ws.test/internal/sbe/consumers');
    expect(seen!.headers[SERVICE_HEADER]).toBe('svc-edge');
    const verdict = verifyServiceHeaders(seen!.headers, KEY, { mode: 'require', rawBody: { retained: true, bytes: Buffer.alloc(0) } });
    expect(verdict.service).toBe('svc-edge');
  });
});
