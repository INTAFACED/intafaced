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
import { handleOmsDisplayQtyDoor, registerOmsDisplayQtyDoor } from './oms-iceberg-http.js';
import { refuseLiveOmsIcebergDisplay } from './oms-iceberg-display.js';
import { startPaperIcebergParent } from './oms-paper-iceberg-start.js';
import { approvePaperIcebergParent } from './oms-paper-iceberg-approve.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';

const SECRET = 'a-execution-oms-iceberg-display-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });

const PAPER_ICEBERG_FILES = [
  'oms-paper-iceberg-approve.ts',
  'oms-paper-iceberg-expire.ts',
  'oms-paper-iceberg-refresh-display.ts',
  'oms-paper-iceberg-release-residual.ts',
  'oms-paper-iceberg-start.ts',
  'oms-paper-iceberg-stop.ts',
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

describe('refuseLiveOmsIcebergDisplay', () => {
  it('refuses live displayQty — never silently full-display', () => {
    expect(refuseLiveOmsIcebergDisplay({ displayQty: '2' })).toMatchObject({
      ok: false,
      reason: 'not_matching_iceberg',
    });
    expect(refuseLiveOmsIcebergDisplay({ iceberg: true, displayQty: '2' })).toMatchObject({
      ok: false,
      reason: 'not_matching_iceberg',
    });
    expect(refuseLiveOmsIcebergDisplay({ kind: 'iceberg', displayQty: formatAmount(parseAmount('2')) })).toMatchObject({
      ok: false,
      reason: 'not_matching_iceberg',
    });
  });

  it('does not refuse a plain OMS limit with no display qty', () => {
    expect(refuseLiveOmsIcebergDisplay({ kind: 'limit' })).toBeNull();
    expect(refuseLiveOmsIcebergDisplay({ displayQty: '  ' })).toBeNull();
    expect(refuseLiveOmsIcebergDisplay({})).toBeNull();
  });

  it('blank-invalid ledger display qty still refuses — no invented size', () => {
    expect(refuseLiveOmsIcebergDisplay({ displayQty: 'not-a-qty' })).toMatchObject({
      ok: false,
      reason: 'not_matching_iceberg',
    });
  });
});

describe('executeOmsRoute live display-qty', () => {
  it('refuses displayQty before submit — no silent full-display', async () => {
    const street = new FakeSource('street');
    const emsStore = new InMemoryEmsOrderStore();
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'sell',
      amount: '10',
      displayQty: '2',
      parentClientOrderId: 'parent-iceberg-display',
      venues: [completeVenue({ id: 'street', price: '100' })],
      submitByVenue: { street: street.submit },
      emsStore,
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_matching_iceberg' });
    expect(street.calls).toHaveLength(0);
    expect(emsStore.list()).toHaveLength(0);
  });

  it('plain execute without displayQty still submits', async () => {
    const street = new FakeSource('street');
    const emsStore = new InMemoryEmsOrderStore();
    const result = await executeOmsRoute({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      parentClientOrderId: 'parent-plain',
      venues: [completeVenue({ id: 'street', price: '100' })],
      submitByVenue: { street: street.submit },
      emsStore,
    });
    expect(result.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
  });
});

describe('POST /execution/oms/display-qty', () => {
  async function app() {
    const f = Fastify();
    installOmsWriteRawBody(f);
    registerOmsDisplayQtyDoor(f, { edgeContext, internalSecret: SERVICE_SECRET });
    await f.ready();
    return f;
  }

  it('refuses anonymous display-qty', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/display-qty',
      payload: { displayQty: '2' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });

  it('signed admin:write refuses OMS displayQty — not a sold iceberg product', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/display-qty',
      headers: hmacHeaders({ displayQty: '2', iceberg: true }),
      payload: JSON.stringify({ displayQty: '2', iceberg: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'not_matching_iceberg' });
    await f.close();
  });

  it('handleOmsDisplayQtyDoor always refuses native OMS iceberg', () => {
    expect(handleOmsDisplayQtyDoor({ displayQty: '2' })).toMatchObject({
      ok: false,
      reason: 'not_matching_iceberg',
    });
    expect(handleOmsDisplayQtyDoor({})).toMatchObject({ ok: false, reason: 'not_matching_iceberg' });
  });
});

describe('paper iceberg family stays paper', () => {
  const paper = { enabled: true } as const;

  it('approve + start stay paper with ledger display qty — no matching, no withdrawHold', () => {
    const approved = approvePaperIcebergParent({
      parentClientOrderId: 'p-ice',
      kind: 'iceberg',
      displayQty: '2',
      operatorId: OP,
      paper,
    });
    expect(approved).toMatchObject({ ok: true, paper: true, status: 'paper', displayQty: formatAmount(parseAmount('2')) });
    const started = startPaperIcebergParent({
      parentClientOrderId: 'p-ice',
      kind: 'iceberg',
      approved: true,
      status: 'paper',
      displayQty: '2',
      operatorId: OP,
      paper,
    });
    expect(started).toMatchObject({ ok: true, paper: true, status: 'paper' });
    expect(started).not.toHaveProperty('matching');
    expect(started).not.toHaveProperty('withdrawHold');
  });

  it('paper iceberg sources never call withdrawHold', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of PAPER_ICEBERG_FILES) {
      const src = readFileSync(join(dir, name), 'utf8');
      expect(src, name).not.toMatch(/withdrawHold/);
    }
  });
});

describe('C03 iceberg is not a sold OMS product', () => {
  it('createExecutionRouter oms has no iceberg symbol', () => {
    const procedures = createExecutionRouter(new SealedHouseTenantRegistry())._def.procedures;
    const symbols = Object.keys(procedures)
      .filter((key) => key.startsWith('execution.oms.'))
      .map((key) => key.slice('execution.oms.'.length).split('.')[0]);
    expect(symbols).not.toContain('iceberg');
    expect(symbols).toContain('execute');
  });
});
