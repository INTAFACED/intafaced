import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { executeOmsRoute, type OmsSubmitFn } from './oms-execute.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { latencyGradeWire, type OmsPlanVenue } from './oms-plan.js';
import { createExecutionRouter } from './router.js';
import { handleOmsPaperDoor, handleOmsPaperExtraDoor, registerOmsPaperDoor } from './oms-paper-http.js';
import type { PaperGate } from './oms-paper.js';
import { refuseLiveOmsPaper } from './oms-paper-refuse.js';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParentStore } from './oms-start.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';

const SECRET = 'a-execution-oms-paper-http-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });
const MILL = [
  'oms-paper.ts',
  'oms-slice.ts',
  'oms-twap-slice.ts',
  'oms-vwap-slice.ts',
  'oms-paper-twap-slice.ts',
  'oms-paper-vwap-slice.ts',
  'oms-paper-sniper-start.ts',
  'oms-paper-trailing-stop-start.ts',
] as const;

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

const SERVICE_SECRET = 'a'.repeat(32);

function hmacHeaders(payload: unknown, service = 'svc-execution') {
  const body = JSON.stringify(payload);
  return {
    'content-type': 'application/json',
    ...serviceAuthHeadersForBody(service, SERVICE_SECRET, body),
  };
}
function signed(p: Principal = principal()) {
  return edgeContext({ headers: signedHeaders(p), id: 'req-signed' });
}

function hmacSigned(p: Principal = principal()) {
  return { ...signed(p), service: 'svc-execution' as const };
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
    parentClientOrderId: 'parent-paper',
    venues: [completeVenue({ id: 'street', price: '100' })],
    submitByVenue: { street: street.submit },
    emsStore,
    ...over,
  });
  return { result, street, emsStore };
}

describe('refuseLiveOmsPaper', () => {
  it('refuses paper flag and paper/family extras — never invents a live child', () => {
    expect(refuseLiveOmsPaper({ paper: true })).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    expect(refuseLiveOmsPaper({ kind: 'paper-twap' })).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    expect(refuseLiveOmsPaper({ kind: 'paper-sniper' })).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    expect(refuseLiveOmsPaper({ kind: 'paper-trailing-stop' })).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    expect(refuseLiveOmsPaper({ kind: 'twap-slice' })).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    expect(refuseLiveOmsPaper({ kind: 'vwap-slice' })).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    expect(refuseLiveOmsPaper({ kind: 'paper-basket' })).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    expect(refuseLiveOmsPaper({ kind: 'paper-rebalance' })).toMatchObject({ ok: false, reason: 'paper_unsupported' });
  });
  it('leaves live twap|vwap|pov kinds alone for oms-slice.ts', () => {
    expect(refuseLiveOmsPaper({ kind: 'twap' })).toBeNull();
    expect(refuseLiveOmsPaper({ kind: 'vwap' })).toBeNull();
    expect(refuseLiveOmsPaper({ kind: 'pov' })).toBeNull();
    expect(refuseLiveOmsPaper({})).toBeNull();
  });
});

describe('executeOmsRoute paper extras', () => {
  it('refuses kind paper-twap before submit', async () => {
    const { result, street } = await runExecute({ kind: 'paper-twap' });
    expect(result).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('refuses paper flag before submit', async () => {
    const { result, street } = await runExecute({ paper: true, parentClientOrderId: 'parent-paper-flag' });
    expect(result).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('plain execute still submits', async () => {
    const { result, street } = await runExecute({ amount: '1', parentClientOrderId: 'parent-plain-paper' });
    expect(result.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
  });
});

describe('POST /execution/oms/paper*', () => {
  async function app() {
    const f = Fastify();
    installOmsWriteRawBody(f);
    registerOmsPaperDoor(f, { edgeContext, internalSecret: SERVICE_SECRET });
    await f.ready();
    return f;
  }
  it('refuses anonymous paper', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/execution/oms/paper', payload: { parentClientOrderId: 'p1' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });
  it('signed admin:write without stores hits mill — paper stays paper', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/paper',
      headers: hmacHeaders({ parentClientOrderId: 'parent-1' }),
      payload: JSON.stringify({ parentClientOrderId: 'parent-1' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'parent_store_unwired' });
    await f.close();
  });
  it('signed admin:write extra refuse', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/paper-extra',
      headers: hmacHeaders({ kind: 'paper-sniper' }),
      payload: JSON.stringify({ kind: 'paper-sniper' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'paper_unsupported' });
    await f.close();
  });
  it('handleOmsPaperDoor never invents a live child', () => {
    expect(handleOmsPaperDoor({ parentClientOrderId: 'p1' })).toMatchObject({ ok: false, reason: 'parent_store_unwired' });
    expect(handleOmsPaperExtraDoor({ kind: 'paper-twap' })).toMatchObject({ ok: false, reason: 'paper_unsupported' });
  });

  it('an HMAC caller cannot paper a parent the server gate refused', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approvedTwap('parent-twap'));
    const f = Fastify();
    installOmsWriteRawBody(f);
    registerOmsPaperDoor(f, {
      edgeContext,
      internalSecret: SERVICE_SECRET,
      parentStore,
      paper: { enabled: false },
    });
    await f.ready();
    const payload = {
      parentClientOrderId: 'parent-twap',
      paper: { enabled: true },
      parentStore: {},
    };
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/paper',
      headers: hmacHeaders(payload),
      payload: JSON.stringify(payload),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'paper_off' });
    expect(res.json()).not.toHaveProperty('children');
    expect(parentStore.get('parent-twap')?.status).toBe('approved');
    await f.close();
  });
});

function approvedTwap(parentClientOrderId: string) {
  return {
    parentClientOrderId,
    kind: 'twap' as const,
    status: 'approved' as const,
    startedAt: null,
    schedule: {
      durationMs: 60_000,
      sliceIntervalMs: 10_000,
      slicesPlanned: 6,
      participationBps: null,
    },
  };
}

describe('handleOmsPaperDoor body cannot open the server gate', () => {
  it('leaves an unwired or off server gate off for {} and {enabled:true}', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approvedTwap('parent-twap'));
    const bodies = [{ paper: {} as PaperGate }, { paper: { enabled: true as const } }];

    for (const paper of bodies) {
      const unwired = handleOmsPaperDoor({ parentClientOrderId: 'parent-twap', ...paper }, { edgeContext: () => ({}), parentStore });
      expect(unwired).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
      expect(parentStore.get('parent-twap')?.status).toBe('approved');

      const off = handleOmsPaperDoor(
        { parentClientOrderId: 'parent-twap', ...paper },
        { edgeContext: () => ({}), parentStore, paper: { enabled: false } },
      );
      expect(off).toMatchObject({ ok: false, reason: 'paper_off' });
      expect(parentStore.get('parent-twap')?.status).toBe('approved');
    }
  });

  it('ignores body.parentStore so a JSON object does not shadow the server store or throw', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approvedTwap('parent-twap'));
    let forgedCalls = 0;
    const forged = {
      get(id: string) {
        forgedCalls += 1;
        return approvedTwap(id);
      },
      paper(id: string) {
        forgedCalls += 1;
        return { ...approvedTwap(id), status: 'paper' as const };
      },
    } as unknown as ApprovedAlgoParentStore;

    const shadowed = handleOmsPaperDoor(
      { parentClientOrderId: 'parent-twap', paper: { enabled: true }, parentStore: forged },
      { edgeContext: () => ({}), parentStore, paper: { enabled: false } },
    );
    expect(shadowed).toMatchObject({ ok: false, reason: 'paper_off' });
    expect(forgedCalls).toBe(0);
    expect(parentStore.get('parent-twap')?.status).toBe('approved');

    const bare = handleOmsPaperDoor(
      {
        parentClientOrderId: 'parent-twap',
        paper: {} as PaperGate,
        parentStore: {} as ApprovedAlgoParentStore,
      },
      { edgeContext: () => ({}), parentStore, paper: { enabled: true } },
    );
    expect(bare).toMatchObject({
      ok: true,
      paper: true,
      status: 'paper',
      children: [],
    });
    expect(bare).not.toHaveProperty('venue');
    expect(parentStore.get('parent-twap')?.status).toBe('paper');
    expect(forgedCalls).toBe(0);
  });

  it('papers through deps.paper and deps.parentStore when the server gate is on', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approvedTwap('parent-on'));
    let forgedCalls = 0;
    const forged = {
      get() {
        forgedCalls += 1;
        return null;
      },
      paper() {
        forgedCalls += 1;
        return null;
      },
    } as unknown as ApprovedAlgoParentStore;

    const out = handleOmsPaperDoor(
      {
        parentClientOrderId: 'parent-on',
        paper: { enabled: false },
        parentStore: forged,
      },
      { edgeContext: () => ({}), parentStore, paper: { enabled: true } },
    );
    expect(out).toMatchObject({
      ok: true,
      paper: true,
      parent: { parentClientOrderId: 'parent-on', kind: 'twap' },
      status: 'paper',
      children: [],
    });
    expect(out).not.toHaveProperty('venue');
    expect(parentStore.get('parent-on')?.status).toBe('paper');
    expect(forgedCalls).toBe(0);
  });
});

describe('paper and family slice mills stay mill', () => {
  it('paper/slice/family mills never match withdrawHold', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of MILL) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/withdrawHold/);
    }
  });
});

describe('OMS slice stays the sold tRPC live product', () => {
  it('createExecutionRouter oms has slice and execute, no family extras', () => {
    const procedures = createExecutionRouter(new SealedHouseTenantRegistry())._def.procedures;
    const symbols = Object.keys(procedures)
      .filter((key) => key.startsWith('execution.oms.'))
      .map((key) => key.slice('execution.oms.'.length).split('.')[0]);
    expect(symbols).toContain('execute');
    expect(symbols).toContain('slice');
    expect(symbols).not.toContain('paper-twap');
    expect(symbols).not.toContain('twap-slice');
    expect(symbols).not.toContain('vwap-slice');
    expect(symbols).not.toContain('paper-sniper');
  });
});
