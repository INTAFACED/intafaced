import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { executeOmsRoute, type OmsSubmitFn } from './oms-execute.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { latencyGradeWire, type OmsPlanVenue } from './oms-plan.js';
import { createExecutionRouter } from './router.js';
import { handleOmsCareDoor, registerOmsCareDoor } from './oms-care-http.js';
import { refuseUnsetDiscretionCap } from './oms-discretion-refuse.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';

const SECRET = 'a-execution-oms-care-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });
const MILL = [
  'oms-claim.ts',
  'oms-assign.ts',
  'oms-pass.ts',
  'oms-shift.ts',
  'oms-fill-confirm.ts',
  'oms-fill-assign.ts',
  'oms-manual-fill.ts',
  'oms-abandon.ts',
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
    parentClientOrderId: 'parent-care',
    venues: [completeVenue({ id: 'street', price: '100' })],
    submitByVenue: { street: street.submit },
    emsStore,
    ...over,
  });
  return { result, street, emsStore };
}

describe('refuseUnsetDiscretionCap', () => {
  it('refuses unset/blank/invalid — never invents a desk limit', () => {
    expect(refuseUnsetDiscretionCap(undefined)).toMatchObject({ ok: false, reason: 'discretion_unset' });
    expect(refuseUnsetDiscretionCap('')).toMatchObject({ ok: false, reason: 'discretion_unset' });
    expect(refuseUnsetDiscretionCap('0')).toMatchObject({ ok: false, reason: 'discretion_unset' });
    expect(refuseUnsetDiscretionCap('x')).toMatchObject({ ok: false, reason: 'discretion_unset' });
  });
  it('accepts a positive ledger amount', () => {
    expect(refuseUnsetDiscretionCap('1000')).toMatchObject({ ok: true, discretionCap: formatAmount(parseAmount('1000')) });
  });
});

describe('executeOmsRoute care extras', () => {
  it('refuses kind claim before submit', async () => {
    const { result, street } = await runExecute({ kind: 'claim' });
    expect(result).toMatchObject({ ok: false, reason: 'care_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('refuses kind manual-fill before submit', async () => {
    const { result, street } = await runExecute({ kind: 'manual-fill', parentClientOrderId: 'parent-mf' });
    expect(result).toMatchObject({ ok: false, reason: 'care_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('explicit blank discretionCap refuses', async () => {
    const { result, street } = await runExecute({ discretionCap: '  ', parentClientOrderId: 'parent-cap' });
    expect(result).toMatchObject({ ok: false, reason: 'discretion_unset' });
    expect(street.calls).toHaveLength(0);
  });
  it('plain execute still submits', async () => {
    const { result, street } = await runExecute({ amount: '1', parentClientOrderId: 'parent-plain-care' });
    expect(result.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
  });
});

describe('POST /execution/oms/care*', () => {
  async function app() {
    const f = Fastify();
    installOmsWriteRawBody(f);
    registerOmsCareDoor(f, { edgeContext, internalSecret: SERVICE_SECRET });
    await f.ready();
    return f;
  }
  it('refuses anonymous care-manual-fill', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/care-manual-fill',
      payload: { discretionCap: '1000', amount: '1', price: '100' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });
  it('signed admin:write unset discretion refuses', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/care-manual-fill',
      headers: hmacHeaders({}),
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'discretion_unset' });
    await f.close();
  });
  it('signed admin:write set cap without confirmer hits mill — no sidecar', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/care-manual-fill',
      headers: hmacHeaders({ discretionCap: '1000' }),
      payload: JSON.stringify({ discretionCap: '1000' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'missing_confirmer' });
    await f.close();
  });
  it('handleOmsCareDoor never invents a cap', () => {
    expect(handleOmsCareDoor({})).toMatchObject({ ok: false, reason: 'discretion_unset' });
    expect(handleOmsCareDoor({ discretionCap: '1000', action: 'manual-fill' })).toMatchObject({
      ok: false,
      reason: 'missing_confirmer',
    });
  });

  it('refuses a missing, blank, or unknown care action and does not report success', () => {
    const cap = '1000';
    for (const action of [undefined, '', '   ', 'release', 'withdraw']) {
      const result = handleOmsCareDoor({ discretionCap: cap, action });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ ok: false, reason: 'action_required' });
      expect(result).not.toHaveProperty('discretionCap');
    }

    const dispatched: ReadonlyArray<readonly [string, string]> = [
      ['claim', 'missing_parent'],
      ['assign', 'missing_operator'],
      ['pass', 'missing_parent'],
      ['shift', 'missing_parent'],
      ['fill-confirm', 'missing_confirmer'],
      ['fill_confirm', 'missing_confirmer'],
      ['fill-assign', 'missing_operator'],
      ['fill_assign', 'missing_operator'],
      ['manual-fill', 'missing_confirmer'],
      ['manual_fill', 'missing_confirmer'],
      ['abandon', 'missing_parent'],
    ];
    for (const [action, reason] of dispatched) {
      expect(handleOmsCareDoor({ discretionCap: cap, action })).toMatchObject({ ok: false, reason });
    }

    expect(handleOmsCareDoor({ action: 'claim' })).toMatchObject({ ok: false, reason: 'discretion_unset' });
    expect(handleOmsCareDoor({ discretionCap: '  ', action: 'pass' })).toMatchObject({
      ok: false,
      reason: 'discretion_unset',
    });
    expect(handleOmsCareDoor({ discretionCap: null, action: 'abandon' })).toMatchObject({
      ok: false,
      reason: 'discretion_unset',
    });
  });
});

describe('care mill stays mill', () => {
  it('care-desk mills never match withdrawHold', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of MILL) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/withdrawHold/);
    }
  });
});

describe('OMS care desk is not a sold tRPC product', () => {
  it('createExecutionRouter oms has execute, no HTTP-only care action names', () => {
    const procedures = createExecutionRouter(new SealedHouseTenantRegistry())._def.procedures;
    const symbols = Object.keys(procedures)
      .filter((key) => key.startsWith('execution.oms.'))
      .map((key) => key.slice('execution.oms.'.length).split('.')[0]);
    expect(symbols).not.toContain('assign');
    expect(symbols).not.toContain('manual-fill');
    expect(symbols).not.toContain('care');
    expect(symbols).toContain('execute');
  });
});
