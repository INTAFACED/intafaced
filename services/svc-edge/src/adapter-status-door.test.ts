import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { SERVICE_HEADER, verifyServiceHeaders } from '@intafaced/contracts';
import {
  ADAPTER_STATUS_EDGE_PATH,
  adapterRead,
  httpAdapterStatusRead,
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
        path: '/internal/status',
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
      return new Response(JSON.stringify(SBE), { status: 200 });
    }) as unknown as typeof fetch;
    const read = httpAdapterStatusRead('http://ws.test/', '/internal/sbe/consumers', KEY, 1000, 'svc-ws', fetchFn);
    expect(await read()).toMatchObject({ kind: 'answered', status: 200 });
    expect(seen!.url).toBe('http://ws.test/internal/sbe/consumers');
    expect(seen!.headers[SERVICE_HEADER]).toBe('svc-edge');
    const verdict = verifyServiceHeaders(seen!.headers, KEY, { mode: 'require', rawBody: { retained: true, bytes: Buffer.alloc(0) } });
    expect(verdict.service).toBe('svc-edge');
  });
});
