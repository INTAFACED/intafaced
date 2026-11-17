import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { createEdgeContext, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { executeOmsRoute, type OmsSubmitFn } from './oms-execute.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { latencyGradeWire, type OmsPlanVenue } from './oms-plan.js';
import { createExecutionRouter } from './router.js';
import { handleOmsPegDoor, registerOmsPegDoor } from './oms-peg-http.js';
import { refuseLiveOmsPeg } from './oms-peg-refuse.js';
import { startPaperPeggedParent } from './oms-paper-pegged-start.js';
import { approvePaperPeggedParent } from './oms-paper-pegged-approve.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';

const SECRET = 'a-execution-oms-peg-refuse-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });

const PAPER_PEGGED_FILES = [
  'oms-paper-pegged-amend-offset.ts',
  'oms-paper-pegged-approve.ts',
  'oms-paper-pegged-expire.ts',
  'oms-paper-pegged-release-residual.ts',
  'oms-paper-pegged-start.ts',
  'oms-paper-pegged-stop.ts',
] as const;

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
    costTerms: {
      feeBps: 10,
      expectedImpactBps: 5,
      transferCostBps: 2,
      latencyGrade: latencyGradeWire(over.id),
    },
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

describe('refuseLiveOmsPeg', () => {
  it('refuses midpoint by field — never maps to a plain limit', () => {
    expect(refuseLiveOmsPeg({ midpoint: true })).toMatchObject({
      ok: false,
      reason: 'midpoint_unsupported',
      field: 'midpoint',
    });
  });

  it('refuses peg by field — never maps to a plain limit', () => {
    expect(refuseLiveOmsPeg({ peg: true })).toMatchObject({
      ok: false,
      reason: 'peg_unsupported',
      field: 'peg',
    });
    expect(refuseLiveOmsPeg({ kind: 'pegged', pegOffset: formatAmount(parseAmount('1')) })).toMatchObject({
      ok: false,
      reason: 'peg_unsupported',
      field: 'kind',
    });
  });

  it('refuses relative and named peg fields by field', () => {
    expect(refuseLiveOmsPeg({ relative: true })).toMatchObject({
      ok: false,
      reason: 'relative_unsupported',
      field: 'relative',
    });
    expect(refuseLiveOmsPeg({ pegType: 'midpoint' })).toMatchObject({
      ok: false,
      reason: 'peg_unsupported',
      field: 'pegType',
    });
    expect(refuseLiveOmsPeg({ pegOffset: '1' })).toMatchObject({
      ok: false,
      reason: 'peg_unsupported',
      field: 'pegOffset',
    });
  });

  it('does not refuse a plain OMS limit with no peg fields', () => {
    expect(refuseLiveOmsPeg({ kind: 'limit' })).toBeNull();
    expect(refuseLiveOmsPeg({})).toBeNull();
  });
});

describe('executeOmsRoute live peg/midpoint', () => {
  it('refuses midpoint before submit — no silent limit map', async () => {
    const street = new FakeSource('street');
    const emsStore = new InMemoryEmsOrderStore();
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '10',
      midpoint: true,
      parentClientOrderId: 'parent-midpoint',
      venues: [completeVenue({ id: 'street', price: '100' })],
      submitByVenue: { street: street.submit },
      emsStore,
    });
    expect(result).toMatchObject({ ok: false, reason: 'midpoint_unsupported' });
    expect(street.calls).toHaveLength(0);
    expect(emsStore.list()).toHaveLength(0);
  });

  it('plain execute without peg fields still submits', async () => {
    const street = new FakeSource('street');
    const emsStore = new InMemoryEmsOrderStore();
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-plain-peg',
      venues: [completeVenue({ id: 'street', price: '100' })],
      submitByVenue: { street: street.submit },
      emsStore,
    });
    expect(result.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
  });
});

describe('POST /execution/oms/peg', () => {
  async function app() {
    const f = Fastify();
    installOmsWriteRawBody(f);
    registerOmsPegDoor(f, { edgeContext, internalSecret: SERVICE_SECRET });
    await f.ready();
    return f;
  }

  it('refuses anonymous peg', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/peg',
      payload: { peg: true },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });

  it('signed admin:write refuses OMS peg by field', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/peg',
      headers: hmacHeaders({ peg: true, pegOffset: '1' }),
      payload: JSON.stringify({ peg: true, pegOffset: '1' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'peg_unsupported', field: 'peg' });
    await f.close();
  });

  it('handleOmsPegDoor always refuses native OMS peg', () => {
    expect(handleOmsPegDoor({ peg: true })).toMatchObject({
      ok: false,
      reason: 'peg_unsupported',
    });
    expect(handleOmsPegDoor({})).toMatchObject({ ok: false, reason: 'peg_unsupported' });
  });
});

describe('paper pegged family stays paper', () => {
  const paper = { enabled: true } as const;

  it('approve + start stay paper with ledger offset — no matching, no withdrawHold', () => {
    const approved = approvePaperPeggedParent({
      parentClientOrderId: 'p-peg',
      kind: 'pegged',
      offset: '1',
      operatorId: OP,
      paper,
    });
    expect(approved).toMatchObject({ ok: true, paper: true, status: 'paper', offset: formatAmount(parseAmount('1')) });
    const started = startPaperPeggedParent({
      parentClientOrderId: 'p-peg',
      kind: 'pegged',
      approved: true,
      status: 'paper',
      offset: '1',
      operatorId: OP,
      paper,
    });
    expect(started).toMatchObject({ ok: true, paper: true, status: 'paper' });
    expect(started).not.toHaveProperty('matching');
    expect(started).not.toHaveProperty('withdrawHold');
  });

  it('paper pegged sources never call withdrawHold', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of PAPER_PEGGED_FILES) {
      const src = readFileSync(join(dir, name), 'utf8');
      expect(src, name).not.toMatch(/withdrawHold/);
    }
  });
});

describe('OMS peg is not a sold tRPC product', () => {
  it('createExecutionRouter oms has no peg/midpoint/pegged symbol', () => {
    const procedures = createExecutionRouter(new SealedHouseTenantRegistry())._def.procedures;
    const symbols = Object.keys(procedures)
      .filter((key) => key.startsWith('execution.oms.'))
      .map((key) => key.slice('execution.oms.'.length).split('.')[0]);
    expect(symbols).not.toContain('peg');
    expect(symbols).not.toContain('midpoint');
    expect(symbols).not.toContain('pegged');
    expect(symbols).toContain('execute');
  });
});
