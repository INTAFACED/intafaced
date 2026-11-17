import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { createEdgeContext, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { executeOmsRoute, type OmsExecuteInput, type OmsSubmitFn } from './oms-execute.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { latencyGradeWire, type OmsPlanVenue } from './oms-plan.js';
import { createExecutionRouter } from './router.js';
import { handleOmsOcoDoor, registerOmsOcoDoor } from './oms-oco-http.js';
import { refuseLiveOmsOco } from './oms-oco-refuse.js';
import { startPaperOcoParent } from './oms-paper-oco-start.js';
import { cancelOtherPaperOcoSiblingOnFill } from './oms-paper-oco-cancel-other.js';
import { startPaperBracketParent } from './oms-paper-bracket-start.js';
import { cancelOtherPaperBracketExitOnFill } from './oms-paper-bracket-cancel-other.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';

const SECRET = 'a-execution-oms-oco-refuse-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });
const PAPER = [
  'oms-paper-oco-approve.ts',
  'oms-paper-oco-cancel-other.ts',
  'oms-paper-oco-expire.ts',
  'oms-paper-oco-release-residual.ts',
  'oms-paper-oco-start.ts',
  'oms-paper-oco-stop.ts',
  'oms-paper-bracket-approve.ts',
  'oms-paper-bracket-cancel-other.ts',
  'oms-paper-bracket-expire.ts',
  'oms-paper-bracket-release-residual.ts',
  'oms-paper-bracket-rest-exits.ts',
  'oms-paper-bracket-start.ts',
  'oms-paper-bracket-stop.ts',
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
async function runExecute(over: Partial<OmsExecuteInput> = {}) {
  const street = new FakeSource('street');
  const emsStore = new InMemoryEmsOrderStore();
  const input: OmsExecuteInput = {
    symbol: 'BTC/USDT',
    side: 'buy',
    amount: '10',
    parentClientOrderId: 'parent-oco',
    venues: [completeVenue({ id: 'street', price: '100' })],
    submitByVenue: { street: street.submit },
    emsStore,
    ...over,
  };
  return { result: await executeOmsRoute(input), street, emsStore };
}

describe('refuseLiveOmsOco', () => {
  it('refuses bracket by field', () => {
    expect(refuseLiveOmsOco({ bracket: true })).toMatchObject({ ok: false, reason: 'bracket_unsupported', field: 'bracket' });
  });
  it('refuses oco by field', () => {
    expect(refuseLiveOmsOco({ oco: true })).toMatchObject({ ok: false, reason: 'oco_unsupported', field: 'oco' });
  });
  it('refuses takeProfit, stopLoss, ocoSiblingId, kind oco/bracket', () => {
    expect(refuseLiveOmsOco({ takeProfit: '101' })).toMatchObject({ ok: false, reason: 'oco_unsupported', field: 'takeProfit' });
    expect(refuseLiveOmsOco({ stopLoss: '99' })).toMatchObject({ ok: false, reason: 'oco_unsupported', field: 'stopLoss' });
    expect(refuseLiveOmsOco({ ocoSiblingId: 'sib-1' })).toMatchObject({ ok: false, reason: 'oco_unsupported', field: 'ocoSiblingId' });
    expect(refuseLiveOmsOco({ kind: 'oco' })).toMatchObject({ ok: false, reason: 'oco_unsupported', field: 'kind' });
    expect(refuseLiveOmsOco({ kind: 'bracket' })).toMatchObject({ ok: false, reason: 'bracket_unsupported', field: 'kind' });
  });
  it('does not refuse a plain OMS limit', () => {
    expect(refuseLiveOmsOco({ kind: 'limit' })).toBeNull();
    expect(refuseLiveOmsOco({})).toBeNull();
  });
});

describe('executeOmsRoute live oco/bracket', () => {
  it('refuses oco before submit', async () => {
    const { result, street, emsStore } = await runExecute({ oco: true });
    expect(result).toMatchObject({ ok: false, reason: 'oco_unsupported' });
    expect(street.calls).toHaveLength(0);
    expect(emsStore.list()).toHaveLength(0);
  });
  it('refuses bracket before submit', async () => {
    const { result, street } = await runExecute({ bracket: true, parentClientOrderId: 'parent-bracket' });
    expect(result).toMatchObject({ ok: false, reason: 'bracket_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('plain execute still submits', async () => {
    const { result, street } = await runExecute({ amount: '1', parentClientOrderId: 'parent-plain-oco' });
    expect(result.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
  });
});

describe('POST /execution/oms/oco', () => {
  async function app() {
    const f = Fastify();
    installOmsWriteRawBody(f);
    registerOmsOcoDoor(f, { edgeContext, internalSecret: SERVICE_SECRET });
    await f.ready();
    return f;
  }
  it('refuses anonymous oco', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/execution/oms/oco', payload: { oco: true } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });
  it('signed admin:write refuses oco by field', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/oco',
      headers: hmacHeaders({ oco: true, takeProfit: '101', stopLoss: '99' }),
      payload: JSON.stringify({ oco: true, takeProfit: '101', stopLoss: '99' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'oco_unsupported', field: 'oco' });
    await f.close();
  });
  it('handleOmsOcoDoor always refuses', () => {
    expect(handleOmsOcoDoor({ oco: true })).toMatchObject({ ok: false, reason: 'oco_unsupported' });
    expect(handleOmsOcoDoor({})).toMatchObject({ ok: false, reason: 'oco_unsupported', field: 'oco' });
  });
});

describe('paper oco/bracket families stay paper', () => {
  const paper = { enabled: true } as const;
  it('startPaperOcoParent + cancelOtherPaperOcoSiblingOnFill stay paper, no matching/withdrawHold', () => {
    const started = startPaperOcoParent({
      parentClientOrderId: 'p-oco',
      kind: 'oco',
      approved: true,
      takeProfit: '101',
      stopLoss: '99',
      operatorId: OP,
      paper,
    });
    expect(started).toMatchObject({
      ok: true,
      paper: true,
      status: 'paper',
      takeProfit: formatAmount(parseAmount('101')),
      stopLoss: formatAmount(parseAmount('99')),
    });
    expect(started).not.toHaveProperty('matching');
    expect(started).not.toHaveProperty('withdrawHold');
    const cancelled = cancelOtherPaperOcoSiblingOnFill({
      parentClientOrderId: 'p-oco',
      kind: 'oco',
      status: 'paper',
      filled: 'take_profit',
      takeProfit: '101',
      stopLoss: '99',
      paper,
    });
    expect(cancelled).toMatchObject({ ok: true, paper: true, filled: 'take_profit', cancelledSibling: 'stop_loss' });
    expect(cancelled).not.toHaveProperty('matching');
    expect(cancelled).not.toHaveProperty('withdrawHold');
  });
  it('startPaperBracketParent + cancelOtherPaperBracketExitOnFill stay paper, no matching/withdrawHold', () => {
    const started = startPaperBracketParent({
      parentClientOrderId: 'p-br',
      kind: 'bracket',
      approved: true,
      entry: '100',
      takeProfit: '101',
      stopLoss: '99',
      operatorId: OP,
      paper,
    });
    expect(started).toMatchObject({ ok: true, paper: true, status: 'paper' });
    expect(started).not.toHaveProperty('matching');
    expect(started).not.toHaveProperty('withdrawHold');
    const cancelled = cancelOtherPaperBracketExitOnFill({
      parentClientOrderId: 'p-br',
      kind: 'bracket',
      status: 'paper',
      filled: 'take_profit',
      takeProfit: '101',
      stopLoss: '99',
      paper,
    });
    expect(cancelled).toMatchObject({ ok: true, paper: true, filled: 'take_profit', cancelledExit: 'stop_loss' });
    expect(cancelled).not.toHaveProperty('matching');
    expect(cancelled).not.toHaveProperty('withdrawHold');
  });
  it('all 13 paper sources never match withdrawHold', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    expect(PAPER).toHaveLength(13);
    for (const name of PAPER) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/withdrawHold/);
    }
  });
});

describe('OMS oco/bracket is not a sold tRPC product', () => {
  it('createExecutionRouter oms has no oco, no bracket, has execute', () => {
    const procedures = createExecutionRouter(new SealedHouseTenantRegistry())._def.procedures;
    const symbols = Object.keys(procedures)
      .filter((key) => key.startsWith('execution.oms.'))
      .map((key) => key.slice('execution.oms.'.length).split('.')[0]);
    expect(symbols).not.toContain('oco');
    expect(symbols).not.toContain('bracket');
    expect(symbols).toContain('execute');
  });
});
