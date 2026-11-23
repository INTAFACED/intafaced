import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { parseAmount } from '@intafaced/ledger-client';
import { createEdgeContext, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { executeOmsRoute, type OmsSubmitFn } from './oms-execute.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { latencyGradeWire, type OmsPlanVenue } from './oms-plan.js';
import { createExecutionRouter } from './router.js';
import { handleOmsTcaClaimDoor, registerOmsTcaDoor } from './oms-tca-http.js';
import { refuseUnsetTcaClaim } from './oms-tca-refuse.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';

const SECRET = 'a-execution-oms-tca-http-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });
const MILL = ['oms-tca.ts', 'oms-tca-parent.ts', 'oms-tca-markouts.ts'] as const;

const SERVICE_SECRET = 'a'.repeat(32);

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
    parentClientOrderId: 'parent-tca',
    venues: [completeVenue({ id: 'street', price: '100' })],
    submitByVenue: { street: street.submit },
    emsStore,
    ...over,
  });
  return { result, street, emsStore };
}

describe('refuseUnsetTcaClaim', () => {
  it('refuses unset benchmark or retained MD — never invents a beat-VWAP', () => {
    expect(refuseUnsetTcaClaim({})).toMatchObject({ ok: false, reason: 'tca_claim_unset' });
    expect(refuseUnsetTcaClaim({ ownerBenchmark: 'interval_vwap' })).toMatchObject({ ok: false, reason: 'tca_claim_unset' });
    expect(refuseUnsetTcaClaim({ retainedMarketData: true })).toMatchObject({ ok: false, reason: 'tca_claim_unset' });
    expect(refuseUnsetTcaClaim({ ownerBenchmark: '', retainedMarketData: 'capture.lake' })).toMatchObject({
      ok: false,
      reason: 'tca_claim_unset',
    });
  });
  it('accepts owner benchmark plus retained market data', () => {
    expect(refuseUnsetTcaClaim({ ownerBenchmark: 'interval_vwap', retainedMarketData: 'capture.lake' })).toMatchObject({
      ok: true,
      ownerBenchmark: 'interval_vwap',
    });
  });
});

describe('executeOmsRoute TCA extras', () => {
  it('refuses kind tca before submit', async () => {
    const { result, street } = await runExecute({ kind: 'tca' });
    expect(result).toMatchObject({ ok: false, reason: 'tca_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('explicit blank ownerBenchmark refuses the claim', async () => {
    const { result, street } = await runExecute({ ownerBenchmark: '  ', parentClientOrderId: 'parent-tca-claim' });
    expect(result).toMatchObject({ ok: false, reason: 'tca_claim_unset' });
    expect(street.calls).toHaveLength(0);
  });
  it('plain execute still submits', async () => {
    const { result, street } = await runExecute({ amount: '1', parentClientOrderId: 'parent-plain-tca' });
    expect(result.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
  });
});

describe('POST /execution/oms/tca*', () => {
  async function app() {
    const f = Fastify();
    installOmsWriteRawBody(f);
    registerOmsTcaDoor(f, { edgeContext, internalSecret: SERVICE_SECRET });
    await f.ready();
    return f;
  }
  it('refuses anonymous tca-claim', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/tca-claim',
      payload: { ownerBenchmark: 'interval_vwap', retainedMarketData: true },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });
  it('signed admin:write unset claim refuses', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/tca-claim',
      headers: hmacHeaders({}),
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'tca_claim_unset' });
    await f.close();
  });
  it('signed admin:write set claim without EMS hits mill — no invented beat', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/tca-claim',
      headers: hmacHeaders({
        ownerBenchmark: 'interval_vwap',
        retainedMarketData: 'capture.lake',
        parentClientOrderId: 'parent-1',
      }),
      payload: JSON.stringify({
        ownerBenchmark: 'interval_vwap',
        retainedMarketData: 'capture.lake',
        parentClientOrderId: 'parent-1',
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
    await f.close();
  });
  it('handleOmsTcaClaimDoor never invents a beat-VWAP', () => {
    expect(handleOmsTcaClaimDoor({})).toMatchObject({ ok: false, reason: 'tca_claim_unset' });
    expect(handleOmsTcaClaimDoor({ ownerBenchmark: 'interval_vwap', retainedMarketData: true })).toMatchObject({
      ok: false,
      reason: 'missing_identity',
    });
  });
});

describe('TCA mill stays mill', () => {
  it('TCA mills never match withdrawHold', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of MILL) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/withdrawHold/);
    }
  });
});

describe('OMS TCA run stays the sold tRPC product', () => {
  it('createExecutionRouter oms has tca, no invented beat-vwap claim symbol', () => {
    const procedures = createExecutionRouter(new SealedHouseTenantRegistry())._def.procedures;
    const symbols = Object.keys(procedures)
      .filter((key) => key.startsWith('execution.oms.'))
      .map((key) => key.slice('execution.oms.'.length).split('.')[0]);
    expect(symbols).toContain('tca');
    expect(symbols).toContain('execute');
    expect(symbols).not.toContain('beat-vwap');
    expect(symbols).not.toContain('tca-claim');
  });
});
