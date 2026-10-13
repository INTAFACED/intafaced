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
import { handleOmsBuyingPowerDoor, registerOmsBuyingPowerDoor } from './oms-buying-power-http.js';
import { refuseUnsetBuyingPower, sliceLiveAlgoParentWithBuyingPower } from './oms-buying-power.js';
import { startPaperScaleInParent } from './oms-paper-scale-in-start.js';
import { sliceImplementationShortfallParent } from './oms-is-slice.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';

const SECRET = 'a-execution-oms-buying-power-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });
const PAPER = [
  'oms-paper-scale-in-approve.ts',
  'oms-paper-scale-in-expire.ts',
  'oms-paper-scale-in-release-residual.ts',
  'oms-paper-scale-in-slice.ts',
  'oms-paper-scale-in-start.ts',
  'oms-paper-scale-in-stop.ts',
  'oms-is-paper-approve.ts',
  'oms-is-paper-expire.ts',
  'oms-is-paper-release-residual.ts',
  'oms-is-paper-slice.ts',
  'oms-is-paper-start.ts',
  'oms-is-paper-stop.ts',
  'oms-is-paper-amend-remaining.ts',
  'oms-paper-sniper-approve.ts',
  'oms-paper-sniper-expire.ts',
  'oms-paper-sniper-fire.ts',
  'oms-paper-sniper-release-residual.ts',
  'oms-paper-sniper-start.ts',
  'oms-paper-sniper-stop.ts',
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
    parentClientOrderId: 'parent-scale',
    venues: [completeVenue({ id: 'street', price: '100' })],
    submitByVenue: { street: street.submit },
    emsStore,
    ...over,
  });
  return { result, street, emsStore };
}

describe('refuseUnsetBuyingPower', () => {
  it('refuses unset/blank/invalid — never invents buying power', () => {
    expect(refuseUnsetBuyingPower(undefined)).toMatchObject({ ok: false, reason: 'buying_power_unset' });
    expect(refuseUnsetBuyingPower(null)).toMatchObject({ ok: false, reason: 'buying_power_unset' });
    expect(refuseUnsetBuyingPower('')).toMatchObject({ ok: false, reason: 'buying_power_unset' });
    expect(refuseUnsetBuyingPower('   ')).toMatchObject({ ok: false, reason: 'buying_power_unset' });
    expect(refuseUnsetBuyingPower('not-an-amount')).toMatchObject({ ok: false, reason: 'buying_power_unset' });
    expect(refuseUnsetBuyingPower('0')).toMatchObject({ ok: false, reason: 'buying_power_unset' });
    expect(refuseUnsetBuyingPower(1000)).toMatchObject({ ok: false, reason: 'buying_power_unset' });
    expect(refuseUnsetBuyingPower({ limit: '1000' })).toMatchObject({ ok: false, reason: 'buying_power_unset' });
  });
  it('accepts a positive ledger amount', () => {
    expect(refuseUnsetBuyingPower('1000')).toMatchObject({ ok: true, buyingPower: formatAmount(parseAmount('1000')) });
  });
});

describe('sliceLiveAlgoParentWithBuyingPower', () => {
  it('refuses unset buying power before slice', async () => {
    const result = await sliceLiveAlgoParentWithBuyingPower({ parentClientOrderId: 'p-slice' });
    expect(result).toMatchObject({ ok: false, reason: 'buying_power_unset' });
  });
  it('passes through to slice when buying power is set', async () => {
    const result = await sliceLiveAlgoParentWithBuyingPower({
      parentClientOrderId: 'p-slice',
      buyingPower: '1000',
    });
    expect(result).toMatchObject({ ok: false, reason: 'parent_store_unwired' });
  });
});

describe('executeOmsRoute scale/IS extras', () => {
  it('refuses scale-in before submit — no second slice engine', async () => {
    const { result, street } = await runExecute({ kind: 'scale-in' });
    expect(result).toMatchObject({ ok: false, reason: 'scale_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('refuses implementation_shortfall before submit', async () => {
    const { result, street } = await runExecute({ kind: 'implementation_shortfall', parentClientOrderId: 'parent-is' });
    expect(result).toMatchObject({ ok: false, reason: 'scale_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('explicit blank buyingPower refuses', async () => {
    const { result, street } = await runExecute({ buyingPower: '  ', parentClientOrderId: 'parent-bp' });
    expect(result).toMatchObject({ ok: false, reason: 'buying_power_unset' });
    expect(street.calls).toHaveLength(0);
  });
  it('plain execute still submits', async () => {
    const { result, street } = await runExecute({ amount: '1', parentClientOrderId: 'parent-plain-bp' });
    expect(result.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
  });
});

describe('POST /execution/oms/buying-power', () => {
  async function app() {
    const f = Fastify();
    installOmsWriteRawBody(f);
    registerOmsBuyingPowerDoor(f, { edgeContext, internalSecret: SERVICE_SECRET });
    await f.ready();
    return f;
  }
  it('refuses anonymous buying-power', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/execution/oms/buying-power', payload: { buyingPower: '1000' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });
  it('signed admin:write refuses unset buying power', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/buying-power',
      headers: hmacHeaders({}),
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'buying_power_unset' });
    await f.close();
  });
  it('signed admin:write accepts a ledger buying power without slicing', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/buying-power',
      headers: hmacHeaders({ buyingPower: '1000' }),
      payload: JSON.stringify({ buyingPower: '1000' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, buyingPower: formatAmount(parseAmount('1000')) });
    await f.close();
  });
  it('handleOmsBuyingPowerDoor never slices', () => {
    expect(handleOmsBuyingPowerDoor({})).toMatchObject({ ok: false, reason: 'buying_power_unset' });
    expect(handleOmsBuyingPowerDoor({ buyingPower: '1000' })).toMatchObject({ ok: true });
  });
  it('signed admin:write refuses a JSON number or object buying power', async () => {
    const f = await app();
    for (const buyingPower of [1000, { limit: '1000' }] as const) {
      const payload = { buyingPower };
      const res = await f.inject({
        method: 'POST',
        url: '/execution/oms/buying-power',
        headers: hmacHeaders(payload),
        payload: JSON.stringify(payload),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: false, reason: 'buying_power_unset' });
    }
    await f.close();
  });
});

describe('paper scale/IS stay paper', () => {
  const paper = { enabled: true } as const;
  it('startPaperScaleInParent stays paper, no matching/withdrawHold', () => {
    const started = startPaperScaleInParent({
      parentClientOrderId: 'p-scale',
      kind: 'scale-in',
      approved: true,
      childSize: '1',
      operatorId: OP,
      paper,
    });
    expect(started).toMatchObject({ ok: true, paper: true, status: 'paper' });
    expect(started).not.toHaveProperty('matching');
    expect(started).not.toHaveProperty('withdrawHold');
  });
  it('sliceImplementationShortfallParent does not submit matching', () => {
    const sliced = sliceImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'running',
      amount: '1',
    });
    expect(sliced).toMatchObject({ ok: true, sliced: true });
    expect(sliced).not.toHaveProperty('matching');
    expect(sliced).not.toHaveProperty('withdrawHold');
  });
  it('paper scale-in / is-paper / sniper sources never match withdrawHold', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of PAPER) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/withdrawHold/);
    }
  });
});

describe('OMS scale/IS is not a sold tRPC product', () => {
  it('createExecutionRouter oms has execute, no scale-in, no implementation_shortfall', () => {
    const procedures = createExecutionRouter(new SealedHouseTenantRegistry())._def.procedures;
    const symbols = Object.keys(procedures)
      .filter((key) => key.startsWith('execution.oms.'))
      .map((key) => key.slice('execution.oms.'.length).split('.')[0]);
    expect(symbols).not.toContain('scale-in');
    expect(symbols).not.toContain('implementation_shortfall');
    expect(symbols).not.toContain('sniper');
    expect(symbols).toContain('execute');
  });
});
