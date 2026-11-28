import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { executeOmsRoute, type OmsSubmitFn } from './oms-execute.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { latencyGradeWire, type OmsPlanVenue } from './oms-plan.js';
import { handleOmsCodDoor, handleOmsKillDoor, handleOmsVenueHaltDoor, registerOmsKillDoor } from './oms-kill-http.js';
import { refuseUnsetCancelOnDisconnect } from './oms-cod-refuse.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';
import { loadMatchingVenueHalt } from './oms-matching-venue-halt.js';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';

const SECRET = 'a-execution-oms-kill-test-edge-secret';
const SERVICE_SECRET = 'a'.repeat(32);
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });
const MILL = ['oms-kill.ts', 'oms-kill-live.ts', 'oms-kill-parent.ts', 'oms-drain.ts', 'oms-matching-venue-halt.ts'] as const;

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
function completeVenue(over: Partial<OmsPlanVenue> & Pick<OmsPlanVenue, 'id' | 'price'>): OmsPlanVenue {
  return {
    kind: 'external-cex',
    amount: '10',
    feeBps: 10,
    costTerms: { feeBps: 10, expectedImpactBps: 5, transferCostBps: 2, latencyGrade: latencyGradeWire(over.id) },
    ...over,
  };
}
class FakeSource {
  readonly calls: unknown[] = [];
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  submit: OmsSubmitFn = async (req) => {
    this.calls.push(req);
    return {
      venueId: this.id,
      venueOrderId: `v-${this.id}`,
      filledAmount: req.amount,
      averagePrice: req.limitPrice,
      feeAmount: parseAmount('0'),
      feeAsset: 'USDT',
      status: 'filled',
      executedAt: new Date('2026-08-17T00:00:00.000Z'),
    };
  };
}
async function runExecute(over: Record<string, unknown> = {}) {
  const street = new FakeSource('street');
  const emsStore = new InMemoryEmsOrderStore();
  const result = await executeOmsRoute({
    symbol: 'BTC/USDT',
    side: 'buy',
    amount: '10',
    parentClientOrderId: 'parent-kill',
    venues: [completeVenue({ id: 'street', price: '100' })],
    submitByVenue: { street: street.submit },
    emsStore,
    ...over,
  });
  return { result, street, emsStore };
}

describe('refuseUnsetCancelOnDisconnect', () => {
  it('refuses unset/blank/off — never invents a flatten', () => {
    expect(refuseUnsetCancelOnDisconnect(undefined)).toMatchObject({ ok: false, reason: 'cod_unset' });
    expect(refuseUnsetCancelOnDisconnect(null)).toMatchObject({ ok: false, reason: 'cod_unset' });
    expect(refuseUnsetCancelOnDisconnect(false)).toMatchObject({ ok: false, reason: 'cod_unset' });
    expect(refuseUnsetCancelOnDisconnect('')).toMatchObject({ ok: false, reason: 'cod_unset' });
    expect(refuseUnsetCancelOnDisconnect('off')).toMatchObject({ ok: false, reason: 'cod_unset' });
  });
  it('accepts an explicit cancel policy', () => {
    expect(refuseUnsetCancelOnDisconnect(true)).toMatchObject({ ok: true, cancelOnDisconnect: true });
    expect(refuseUnsetCancelOnDisconnect('cancel')).toMatchObject({ ok: true, cancelOnDisconnect: true });
  });
});

describe('executeOmsRoute kill extras', () => {
  it('refuses kind kill before submit', async () => {
    const { result, street } = await runExecute({ kind: 'kill' });
    expect(result).toMatchObject({ ok: false, reason: 'kill_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('refuses kind drain before submit', async () => {
    const { result, street } = await runExecute({ kind: 'drain', parentClientOrderId: 'parent-drain' });
    expect(result).toMatchObject({ ok: false, reason: 'kill_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('explicit blank cancelOnDisconnect refuses', async () => {
    const { result, street } = await runExecute({ cancelOnDisconnect: '  ', parentClientOrderId: 'parent-cod' });
    expect(result).toMatchObject({ ok: false, reason: 'cod_unset' });
    expect(street.calls).toHaveLength(0);
  });
  it('plain execute still submits', async () => {
    const { result, street } = await runExecute({ amount: '1', parentClientOrderId: 'parent-plain-kill' });
    expect(result.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
  });
});

describe('POST /execution/oms/kill*', () => {
  async function app() {
    const f = Fastify();
    installOmsWriteRawBody(f);
    registerOmsKillDoor(f, { edgeContext, internalSecret: SERVICE_SECRET });
    await f.ready();
    return f;
  }

  it('session-only admin:write cannot POST /kill', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/kill',
      headers: signedHeaders(),
      payload: { session: 'sess-1' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });

  it('svc-trade HMAC is 403 on /kill', async () => {
    const f = await app();
    const payload = { session: 'sess-1' };
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/kill',
      headers: {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-trade', SERVICE_SECRET, JSON.stringify(payload)),
      },
      payload: JSON.stringify(payload),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    await f.close();
  });

  it('svc-execution HMAC /kill missing scope refuses flatten', async () => {
    const f = await app();
    const payload = {};
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/kill',
      headers: {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-execution', SERVICE_SECRET, JSON.stringify(payload)),
      },
      payload: JSON.stringify(payload),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'missing_scope' });
    await f.close();
  });
  it('refuses anonymous COD', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/cod',
      payload: { cancelOnDisconnect: 'cancel', session: 'sess-1' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });
  it('signed admin:write unset COD refuses', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/cod',
      headers: hmacHeaders({}),
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'cod_unset' });
    await f.close();
  });
  it('signed admin:write set COD without session refuses flatten', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/cod',
      headers: hmacHeaders({ cancelOnDisconnect: 'cancel' }),
      payload: JSON.stringify({ cancelOnDisconnect: 'cancel' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'missing_scope' });
    await f.close();
  });
  it('handleOmsKillDoor missing scope refuses — never invents flatten', async () => {
    await expect(handleOmsKillDoor({})).resolves.toMatchObject({ ok: false, reason: 'missing_scope' });
  });
  it('handleOmsCodDoor never invents a flatten', async () => {
    await expect(handleOmsCodDoor({})).resolves.toMatchObject({ ok: false, reason: 'cod_unset' });
    await expect(handleOmsCodDoor({ cancelOnDisconnect: 'cancel' })).resolves.toMatchObject({
      ok: false,
      reason: 'missing_scope',
    });
  });
  it('handleOmsVenueHaltDoor missing source refuses — never invents live', async () => {
    await expect(handleOmsVenueHaltDoor(undefined)).resolves.toMatchObject({
      ok: false,
      reason: 'venue_halt_unavailable',
    });
  });
  it('handleOmsVenueHaltDoor halted is cancel-only consume', async () => {
    await expect(handleOmsVenueHaltDoor({ venueHalted: true })).resolves.toMatchObject({
      ok: false,
      reason: 'venue_halted',
    });
  });
});

describe('kill mill stays mill', () => {
  it('kill/drain/halt mills never match withdrawHold', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of MILL) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/withdrawHold/);
    }
  });
  it('HTTP door never POSTs matching halt-all', async () => {
    // The routes the kill door registers: four POSTs of its own, none of them matching's halt-all.
    const f = Fastify();
    const routes: string[] = [];
    f.addHook('onRoute', (route) => {
      routes.push(`${String(route.method)} ${route.url}`);
    });
    registerOmsKillDoor(f, { edgeContext, internalSecret: SERVICE_SECRET });
    await f.ready();
    await f.close();
    expect(routes.sort()).toEqual([
      'POST /execution/oms/cod',
      'POST /execution/oms/drain',
      'POST /execution/oms/kill',
      'POST /execution/oms/venue-halt',
    ]);
    // The venue-halt door reads matching's GET /markets and sends nothing else.
    const seen: string[] = [];
    const answer = await handleOmsVenueHaltDoor(() =>
      loadMatchingVenueHalt({
        matchingUrl: 'http://matching.test',
        fetch: async (input, init) => {
          seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
          return new Response(JSON.stringify({ venueHalted: false }), { status: 200 });
        },
      }),
    );
    expect(answer).toEqual({ ok: true, venueHalted: false });
    expect(seen).toEqual(['GET http://matching.test/markets']);
  });
});

describe('prove which kill files are live', () => {
  it('router uses oms-kill + kill-parent HTTP door; kill-live stays extra', async () => {
    // Load the router fresh and note which kill modules it pulls in; loading oms-kill-live fails the load.
    const loaded: string[] = [];
    vi.resetModules();
    vi.doMock('./oms-kill.js', async (importOriginal) => {
      loaded.push('oms-kill');
      return importOriginal();
    });
    vi.doMock('./oms-kill-parent-http.js', async (importOriginal) => {
      loaded.push('oms-kill-parent-http');
      return importOriginal();
    });
    vi.doMock('./oms-kill-live.js', () => {
      throw new Error('the router loaded oms-kill-live');
    });
    try {
      const { createExecutionRouter: fresh } = await import('./router.js');
      expect(loaded.sort()).toEqual(['oms-kill', 'oms-kill-parent-http']);
      const procedures = Object.keys(fresh(new SealedHouseTenantRegistry())._def.procedures);
      expect(procedures).toEqual(expect.arrayContaining(['execution.oms.kill', 'execution.oms.killParent']));
      expect(procedures.filter((path) => /cancelOnDisconnect/i.test(path))).toEqual([]);
    } finally {
      vi.doUnmock('./oms-kill.js');
      vi.doUnmock('./oms-kill-parent-http.js');
      vi.doUnmock('./oms-kill-live.js');
      vi.resetModules();
    }
  });
});
