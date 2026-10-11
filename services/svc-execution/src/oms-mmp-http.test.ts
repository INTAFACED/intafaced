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
import { handleOmsMmpHedgeDoor, handleOmsMmpPostDoor, registerOmsMmpDoor } from './oms-mmp-http.js';
import { refuseLiveOmsMmp } from './oms-mmp-refuse.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';

const SECRET = 'a-execution-oms-buying-power-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });
const MILL = ['oms-mmp-post.ts', 'oms-mmp-hedge.ts', 'oms-mmp-mqq.ts'] as const;

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
    parentClientOrderId: 'parent-mmp',
    venues: [completeVenue({ id: 'street', price: '100' })],
    submitByVenue: { street: street.submit },
    emsStore,
    ...over,
  });
  return { result, street, emsStore };
}

const twoSidedPost = {
  parentClientOrderId: 'mmp-1',
  quoteId: 'q-1',
  symbol: 'BTC/USDT',
  bidQuoteId: 'bid-1',
  askQuoteId: 'ask-1',
  mqq: '1',
  bidSize: '5',
  askSize: '5',
};

describe('refuseLiveOmsMmp', () => {
  it('refuses kind mmp / mass-quote', () => {
    expect(refuseLiveOmsMmp({ kind: 'mmp' })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(refuseLiveOmsMmp({ kind: 'mass-quote' })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(refuseLiveOmsMmp({ kind: ' mass_quote ' })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(refuseLiveOmsMmp({ kind: 'mqq' })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(refuseLiveOmsMmp({ kind: 'market-maker' })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(refuseLiveOmsMmp({ kind: 'MARKET_MAKER' })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
  });
  it('refuses mmp/massQuote flags and delta/vega when present', () => {
    expect(refuseLiveOmsMmp({ mmp: true })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(refuseLiveOmsMmp({ massQuote: true })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(refuseLiveOmsMmp({ delta: '1' })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(refuseLiveOmsMmp({ vega: '1' })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(refuseLiveOmsMmp({ delta: '0' })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
  });
  it('plain limit with none of those fields returns null', () => {
    expect(refuseLiveOmsMmp({})).toBeNull();
    expect(refuseLiveOmsMmp({ kind: 'limit' })).toBeNull();
    expect(refuseLiveOmsMmp({ mmp: false, massQuote: false })).toBeNull();
    expect(refuseLiveOmsMmp({ delta: null, vega: null })).toBeNull();
  });
});

describe('executeOmsRoute MMP extras', () => {
  it('refuses kind mmp before submit — no matching dual-impl', async () => {
    const { result, street } = await runExecute({ kind: 'mmp' });
    expect(result).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('refuses delta before submit — does not invent greeks', async () => {
    const { result, street } = await runExecute({ delta: '1' });
    expect(result).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(street.calls).toHaveLength(0);
  });
  it('plain execute still submits', async () => {
    const { result, street } = await runExecute({ amount: '1', parentClientOrderId: 'parent-plain-mmp' });
    expect(result.ok).toBe(true);
    expect(street.calls).toHaveLength(1);
  });
});

describe('POST /execution/oms/mmp-post|hedge|mqq', () => {
  async function app() {
    const f = Fastify();
    installOmsWriteRawBody(f);
    registerOmsMmpDoor(f, { edgeContext, internalSecret: SERVICE_SECRET });
    await f.ready();
    return f;
  }
  async function authed(f: Awaited<ReturnType<typeof app>>, url: string, payload: unknown) {
    return f.inject({
      method: 'POST',
      url,
      headers: hmacHeaders(payload),
      payload: JSON.stringify(payload),
    });
  }
  const liveQuote = {
    quoteId: 'q-1',
    symbol: 'BTC/USDT',
    bidQuoteId: 'bid-1',
    askQuoteId: 'ask-1',
    bidRemaining: '2.25',
    askRemaining: '3.5',
  };
  it('refuses anonymous mmp-post', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/execution/oms/mmp-post', payload: twoSidedPost });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });
  it('signed admin:write blank mqq — mill mqq_blank', async () => {
    const f = await app();
    const payload = { ...twoSidedPost, mqq: '' };
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/mmp-post',
      headers: hmacHeaders(payload),
      payload: JSON.stringify(payload),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'mqq_blank' });
    await f.close();
  });
  it('signed admin:write valid two-sided post — posted both sides', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/mmp-post',
      headers: hmacHeaders(twoSidedPost),
      payload: JSON.stringify(twoSidedPost),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, posted: true, sides: ['bid', 'ask'] });
    await f.close();
  });
  it('signed hedge with delta in body — mmp_unsupported, does not call mill hedge', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/mmp-hedge',
      headers: hmacHeaders({ parentClientOrderId: 'parent-mmp', hedgeSize: '3', delta: '1' }),
      payload: JSON.stringify({ parentClientOrderId: 'parent-mmp', hedgeSize: '3', delta: '1' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(res.json()).not.toHaveProperty('hedged');
    expect(handleOmsMmpHedgeDoor({ parentClientOrderId: 'parent-mmp', hedgeSize: '3', delta: '1' })).toMatchObject({
      ok: false,
      reason: 'mmp_unsupported',
    });
    expect(handleOmsMmpHedgeDoor({ delta: '1' })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    await f.close();
  });
  it('signed mqq blank — mill mqq_blank', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/mmp-mqq',
      headers: hmacHeaders({ mqq: null, quotes: [] }),
      payload: JSON.stringify({ mqq: null, quotes: [] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'mqq_blank' });
    await f.close();
  });
  it('non-string post size or mqq is a typed refusal, not a 500', async () => {
    const f = await app();
    const cases: { payload: unknown; reason: string }[] = [
      { payload: { ...twoSidedPost, bidSize: 5 }, reason: 'size_invalid' },
      { payload: { ...twoSidedPost, askSize: { n: 1 } }, reason: 'size_invalid' },
      { payload: { ...twoSidedPost, mqq: 1 }, reason: 'mqq_invalid' },
      { payload: { ...twoSidedPost, bidSize: '' }, reason: 'size_blank' },
      { payload: { ...twoSidedPost, bidSize: '-1' }, reason: 'size_invalid' },
      { payload: { ...twoSidedPost, mqq: 'nope' }, reason: 'mqq_invalid' },
    ];
    for (const { payload, reason } of cases) {
      const res = await authed(f, '/execution/oms/mmp-post', payload);
      expect(res.statusCode, reason).toBe(200);
      expect(res.json(), reason).toMatchObject({ ok: false, reason });
    }
    const decimal = await authed(f, '/execution/oms/mmp-post', {
      ...twoSidedPost,
      mqq: '1.5',
      bidSize: '2.25',
      askSize: '3.5',
    });
    expect(decimal.statusCode).toBe(200);
    expect(decimal.json()).toMatchObject({
      ok: true,
      posted: true,
      sides: ['bid', 'ask'],
      mqq: '1.5',
      bidSize: '2.25',
      askSize: '3.5',
    });
    const greekFirst = await authed(f, '/execution/oms/mmp-post', { ...twoSidedPost, bidSize: 5, delta: '1' });
    expect(greekFirst.statusCode).toBe(200);
    expect(greekFirst.json()).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    await f.close();
  });
  it('non-string hedge size is a typed refusal, not a 500', async () => {
    const f = await app();
    const cases: { payload: unknown; reason: string }[] = [
      { payload: { parentClientOrderId: 'parent-mmp', hedgeSize: 4 }, reason: 'hedge_size_invalid' },
      { payload: { parentClientOrderId: 'parent-mmp', hedgeSize: { n: 1 } }, reason: 'hedge_size_invalid' },
      { payload: { parentClientOrderId: 'parent-mmp', hedgeSize: '' }, reason: 'hedge_size_blank' },
      { payload: { parentClientOrderId: 'parent-mmp', hedgeSize: '-2' }, reason: 'hedge_size_invalid' },
    ];
    for (const { payload, reason } of cases) {
      const res = await authed(f, '/execution/oms/mmp-hedge', payload);
      expect(res.statusCode, reason).toBe(200);
      expect(res.json(), reason).toMatchObject({ ok: false, reason });
    }
    const decimal = await authed(f, '/execution/oms/mmp-hedge', {
      parentClientOrderId: 'parent-mmp',
      hedgeSize: '1.25',
    });
    expect(decimal.statusCode).toBe(200);
    expect(decimal.json()).toMatchObject({ ok: true, hedged: true, hedgeSize: '1.25' });
    const greekFirst = await authed(f, '/execution/oms/mmp-hedge', {
      parentClientOrderId: 'parent-mmp',
      hedgeSize: 4,
      vega: '1',
    });
    expect(greekFirst.statusCode).toBe(200);
    expect(greekFirst.json()).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    await f.close();
  });
  it('non-string mqq or a quotes value that is not an array is a typed refusal, not a 500', async () => {
    const f = await app();
    const numericMqq = await authed(f, '/execution/oms/mmp-mqq', { mqq: 2, quotes: [] });
    expect(numericMqq.statusCode).toBe(200);
    expect(numericMqq.json()).toMatchObject({ ok: false, reason: 'mqq_invalid' });
    const blankMqqBeatsBadQuotes = await authed(f, '/execution/oms/mmp-mqq', { mqq: '', quotes: {} });
    expect(blankMqqBeatsBadQuotes.statusCode).toBe(200);
    expect(blankMqqBeatsBadQuotes.json()).toMatchObject({ ok: false, reason: 'mqq_blank' });
    const notArrays = ['', '10', { quoteId: 'q-1' }, 4];
    for (const quotes of notArrays) {
      const res = await authed(f, '/execution/oms/mmp-mqq', { mqq: '1', quotes });
      expect(res.statusCode, JSON.stringify(quotes)).toBe(200);
      expect(res.json(), JSON.stringify(quotes)).toMatchObject({ ok: false, reason: 'remaining_blank' });
      expect(res.json().cancelled, JSON.stringify(quotes)).toBeUndefined();
    }
    const nullQuote = await authed(f, '/execution/oms/mmp-mqq', { mqq: '1', quotes: [null] });
    expect(nullQuote.statusCode).toBe(200);
    expect(nullQuote.json()).toMatchObject({ ok: false, reason: 'remaining_blank' });
    const stringElement = await authed(f, '/execution/oms/mmp-mqq', { mqq: '1', quotes: ['10'] });
    expect(stringElement.statusCode).toBe(200);
    expect(stringElement.json()).toMatchObject({ ok: false, reason: 'remaining_blank' });
    const numericSize = await authed(f, '/execution/oms/mmp-mqq', {
      mqq: '1',
      quotes: [{ ...liveQuote, bidRemaining: 2, askRemaining: '3' }],
    });
    expect(numericSize.statusCode).toBe(200);
    expect(numericSize.json()).toMatchObject({ ok: false, reason: 'remaining_invalid' });
    const nullSize = await authed(f, '/execution/oms/mmp-mqq', {
      mqq: '1',
      quotes: [{ ...liveQuote, bidRemaining: null }],
    });
    expect(nullSize.statusCode).toBe(200);
    expect(nullSize.json()).toMatchObject({ ok: false, reason: 'remaining_blank' });
    const negative = await authed(f, '/execution/oms/mmp-mqq', {
      mqq: '1',
      quotes: [{ ...liveQuote, askRemaining: '-1' }],
    });
    expect(negative.statusCode).toBe(200);
    expect(negative.json()).toMatchObject({ ok: false, reason: 'remaining_invalid' });
    const decimal = await authed(f, '/execution/oms/mmp-mqq', { mqq: '1.5', quotes: [liveQuote] });
    expect(decimal.statusCode).toBe(200);
    expect(decimal.json()).toMatchObject({
      ok: true,
      mqq: '1.5',
      cancelled: [],
      leftStanding: [liveQuote],
    });
    const greekFirst = await authed(f, '/execution/oms/mmp-mqq', { mqq: 2, quotes: '10', delta: '1' });
    expect(greekFirst.statusCode).toBe(200);
    expect(greekFirst.json()).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    await f.close();
  });
  it('handleOmsMmpPostDoor never invents greeks or matching', () => {
    expect(handleOmsMmpPostDoor({ ...twoSidedPost, vega: 1 })).toMatchObject({ ok: false, reason: 'mmp_unsupported' });
    expect(handleOmsMmpPostDoor(twoSidedPost)).toMatchObject({ ok: true, posted: true, sides: ['bid', 'ask'] });
  });
});

describe('MMP mill stays mill', () => {
  it('mill sources never match withdrawHold', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of MILL) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/withdrawHold/);
    }
  });
});

describe('OMS MMP is not a sold matching product', () => {
  it('createExecutionRouter oms has execute, no mmp / mass-quote / mqq', () => {
    const procedures = createExecutionRouter(new SealedHouseTenantRegistry())._def.procedures;
    const symbols = Object.keys(procedures)
      .filter((key) => key.startsWith('execution.oms.'))
      .map((key) => key.slice('execution.oms.'.length).split('.')[0]);
    expect(symbols).not.toContain('mmp');
    expect(symbols).not.toContain('mass-quote');
    expect(symbols).not.toContain('mqq');
    expect(symbols).toContain('execute');
  });
});
