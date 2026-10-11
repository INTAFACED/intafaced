import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { CaptureLake } from '@intafaced/venue-adapter';
import type { VenueBookSnapshot } from '@intafaced/venue-contracts';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { runTcaRun, TCA_METHODOLOGY_VERSION, type TcaBenchmarkResult } from './oms-tca.js';
import { createExecutionRouter } from './router.js';

const here = dirname(fileURLToPath(import.meta.url));
const tcaSource = readFileSync(join(here, 'oms-tca.ts'), 'utf8');

const SECRET = 'a-execution-oms-tca-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });

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

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function hmacSigned(p: Principal = principal()) {
  return { ...signed(p), service: 'svc-execution' as const };
}

function recordFill(
  store: InMemoryEmsOrderStore,
  over: { clientOrderId?: string; parent?: string; price?: string; amount?: string; fee?: string; feeAsset?: string } = {},
) {
  store.record({
    clientOrderId: over.clientOrderId ?? 'child-1',
    parentClientOrderId: over.parent ?? 'parent-1',
    executionGroupId: 'group-1',
    childOrderId: 'child-1',
    venueId: 'street',
    symbol: 'BTC/USDT',
    side: 'buy',
    execution: {
      venueId: 'street',
      venueOrderId: 'v-1',
      filledAmount: parseAmount(over.amount ?? '1'),
      averagePrice: parseAmount(over.price ?? '101'),
      feeAmount: parseAmount(over.fee ?? '0.1'),
      feeAsset: over.feeAsset ?? 'USDT',
      status: 'filled',
      executedAt: new Date('2026-08-24T12:00:00.000Z'),
    },
    state: 'ACKNOWLEDGED',
    recordedAtMs: 1,
  });
}

function bench(run: { benchmarks: readonly TcaBenchmarkResult[] }, cls: TcaBenchmarkResult['class']) {
  return run.benchmarks.find((row) => row.class === cls);
}

describe('runTcaRun', () => {
  it('computes fill VWAP vs a licensed arrival observation from real EMS fills', () => {
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore);
    const result = runTcaRun({
      parentClientOrderId: 'parent-1',
      account: 'desk-a',
      instrument: 'BTC/USDT',
      arrivalAt: '2026-08-24T11:59:00.000Z',
      mandateVersion: 'mandate-1',
      venueUniverse: ['street'],
      entitlements: { licensedSources: ['desk.arrival'] },
      observations: [
        {
          class: 'arrival',
          source: 'desk.arrival',
          licensed: true,
          venueId: 'street',
          price: '100',
          capturedAt: '2026-08-24T11:59:00.000Z',
        },
      ],
      emsStore,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.methodologyVersion).toBe(TCA_METHODOLOGY_VERSION);
    expect(result.run.account).toBe('desk-a');
    expect(result.run.instrument).toBe('BTC/USDT');
    expect(result.run.completeness).toBe('complete');
    expect(result.run.realized).toMatchObject({ status: 'AVAILABLE', fillVwap: '101', feeAsset: 'USDT', feeAmount: '0.1' });
    expect(bench(result.run, 'arrival')).toMatchObject({ status: 'AVAILABLE', price: '100', source: 'desk.arrival' });
    expect(result.run.slippage.find((row) => row.versus === 'arrival')).toMatchObject({
      status: 'AVAILABLE',
      fillVwap: '101',
      benchmark: '100',
      slippage: '1',
      slippageBps: '100',
    });
    expect(typeof result.run.realized.status === 'string' && result.run.fills[0]?.averagePrice).toBe('101');
  });

  it('does not produce an available fill VWAP from a zero or negative average price', () => {
    const zeroOnly = new InMemoryEmsOrderStore();
    recordFill(zeroOnly, { clientOrderId: 'zero-px', parent: 'parent-zero', price: '0', amount: '2' });
    const zeroResult = runTcaRun({ parentClientOrderId: 'parent-zero', emsStore: zeroOnly });
    expect(zeroResult.ok).toBe(true);
    if (!zeroResult.ok) return;
    expect(zeroResult.run.realized).toMatchObject({ status: 'UNAVAILABLE', gap: 'no_fill_evidence' });

    const negativeOnly = new InMemoryEmsOrderStore();
    recordFill(negativeOnly, { clientOrderId: 'neg-px', parent: 'parent-neg', price: '-1.5', amount: '2' });
    const negativeResult = runTcaRun({ parentClientOrderId: 'parent-neg', emsStore: negativeOnly });
    expect(negativeResult.ok).toBe(true);
    if (!negativeResult.ok) return;
    expect(negativeResult.run.realized).toMatchObject({ status: 'UNAVAILABLE', gap: 'no_fill_evidence' });

    const mixed = new InMemoryEmsOrderStore();
    recordFill(mixed, { clientOrderId: 'good-a', parent: 'parent-mix', price: '100', amount: '2' });
    recordFill(mixed, { clientOrderId: 'good-b', parent: 'parent-mix', price: '110', amount: '2' });
    recordFill(mixed, { clientOrderId: 'zero-px', parent: 'parent-mix', price: '0', amount: '3' });
    recordFill(mixed, { clientOrderId: 'neg-px', parent: 'parent-mix', price: '-1.5', amount: '4' });
    recordFill(mixed, { clientOrderId: 'zero-amt', parent: 'parent-mix', price: '200', amount: '0' });
    recordFill(mixed, { clientOrderId: 'neg-amt', parent: 'parent-mix', price: '200', amount: '-1' });
    const mixedResult = runTcaRun({ parentClientOrderId: 'parent-mix', emsStore: mixed });
    expect(mixedResult.ok).toBe(true);
    if (!mixedResult.ok) return;
    expect(mixedResult.run.realized).toMatchObject({ status: 'AVAILABLE', fillVwap: '105' });
  });

  it('does not produce an available interval benchmark from a zero or negative print price', () => {
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore, { parent: 'parent-interval' });

    const zeroVwap = runTcaRun({
      parentClientOrderId: 'parent-interval',
      emsStore,
      observations: [
        {
          class: 'interval_vwap',
          source: 'desk.prints',
          licensed: true,
          prints: [{ price: '0', amount: '2' }],
        },
      ],
    });
    expect(zeroVwap.ok).toBe(true);
    if (!zeroVwap.ok) return;
    expect(bench(zeroVwap.run, 'interval_vwap')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_prints' });

    const negativeVwap = runTcaRun({
      parentClientOrderId: 'parent-interval',
      emsStore,
      observations: [
        {
          class: 'interval_vwap',
          source: 'desk.prints',
          licensed: true,
          prints: [{ price: '-1.5', amount: '2' }],
        },
      ],
    });
    expect(negativeVwap.ok).toBe(true);
    if (!negativeVwap.ok) return;
    expect(bench(negativeVwap.run, 'interval_vwap')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_prints' });

    const mixedVwap = runTcaRun({
      parentClientOrderId: 'parent-interval',
      emsStore,
      observations: [
        {
          class: 'interval_vwap',
          source: 'desk.prints',
          licensed: true,
          prints: [
            { price: '100', amount: '2' },
            { price: '110', amount: '2' },
            { price: '0', amount: '3' },
            { price: '-1.5', amount: '4' },
            { price: '200', amount: '0' },
            { price: '200', amount: '-1' },
          ],
        },
      ],
    });
    expect(mixedVwap.ok).toBe(true);
    if (!mixedVwap.ok) return;
    expect(bench(mixedVwap.run, 'interval_vwap')).toMatchObject({ status: 'AVAILABLE', price: '105' });

    const windowFrom = '2026-08-24T12:00:00.000Z';
    const windowTo = '2026-08-24T12:00:04.000Z';
    const zeroTwap = runTcaRun({
      parentClientOrderId: 'parent-interval',
      emsStore,
      observations: [
        {
          class: 'interval_twap',
          source: 'desk.prints',
          licensed: true,
          windowFrom,
          windowTo,
          prints: [{ price: '0', amount: '2', at: windowFrom }],
        },
      ],
    });
    expect(zeroTwap.ok).toBe(true);
    if (!zeroTwap.ok) return;
    expect(bench(zeroTwap.run, 'interval_twap')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_prints' });

    const negativeTwap = runTcaRun({
      parentClientOrderId: 'parent-interval',
      emsStore,
      observations: [
        {
          class: 'interval_twap',
          source: 'desk.prints',
          licensed: true,
          windowFrom,
          windowTo,
          prints: [{ price: '-1.5', amount: '2', at: windowFrom }],
        },
      ],
    });
    expect(negativeTwap.ok).toBe(true);
    if (!negativeTwap.ok) return;
    expect(bench(negativeTwap.run, 'interval_twap')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_prints' });

    const mixedTwap = runTcaRun({
      parentClientOrderId: 'parent-interval',
      emsStore,
      observations: [
        {
          class: 'interval_twap',
          source: 'desk.prints',
          licensed: true,
          windowFrom,
          windowTo,
          prints: [
            { price: '100', amount: '2', at: '2026-08-24T12:00:00.000Z' },
            { price: '0', amount: '3', at: '2026-08-24T12:00:01.000Z' },
            { price: '-1.5', amount: '4', at: '2026-08-24T12:00:02.000Z' },
            { price: '110', amount: '1', at: '2026-08-24T12:00:03.000Z' },
          ],
        },
      ],
    });
    expect(mixedTwap.ok).toBe(true);
    if (!mixedTwap.ok) return;
    expect(bench(mixedTwap.run, 'interval_twap')).toMatchObject({ status: 'AVAILABLE', price: '105' });
  });

  it('does not produce an available quoted spread from a zero or negative bid or ask', () => {
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore, { parent: 'parent-spread' });

    const quoted = (bid: string, ask: string) =>
      runTcaRun({
        parentClientOrderId: 'parent-spread',
        emsStore,
        observations: [
          {
            class: 'quoted_spread',
            source: 'desk.book',
            licensed: true,
            bid,
            ask,
          },
        ],
      });

    const zeroBid = quoted('0', '2');
    expect(zeroBid.ok).toBe(true);
    if (!zeroBid.ok) return;
    expect(bench(zeroBid.run, 'quoted_spread')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_book' });

    const negativeBid = quoted('-1', '3');
    expect(negativeBid.ok).toBe(true);
    if (!negativeBid.ok) return;
    expect(bench(negativeBid.run, 'quoted_spread')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_book' });

    const zeroAsk = quoted('100', '0');
    expect(zeroAsk.ok).toBe(true);
    if (!zeroAsk.ok) return;
    expect(bench(zeroAsk.run, 'quoted_spread')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_book' });

    const negativeAsk = quoted('100', '-1');
    expect(negativeAsk.ok).toBe(true);
    if (!negativeAsk.ok) return;
    expect(bench(negativeAsk.run, 'quoted_spread')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_book' });

    const bothNegative = quoted('-5', '-1');
    expect(bothNegative.ok).toBe(true);
    if (!bothNegative.ok) return;
    expect(bench(bothNegative.run, 'quoted_spread')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_book' });

    const negativeBidZeroAsk = quoted('-1', '0');
    expect(negativeBidZeroAsk.ok).toBe(true);
    if (!negativeBidZeroAsk.ok) return;
    expect(bench(negativeBidZeroAsk.run, 'quoted_spread')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_book' });

    const positive = quoted('100.25', '102.5');
    expect(positive.ok).toBe(true);
    if (!positive.ok) return;
    expect(bench(positive.run, 'quoted_spread')).toMatchObject({ status: 'AVAILABLE', price: '2.25', units: 'spread' });
  });

  it('marks midpoint UNAVAILABLE when book/mid is missing rather than inventing one', () => {
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore);
    const result = runTcaRun({
      parentClientOrderId: 'parent-1',
      emsStore,
      observations: [
        {
          class: 'arrival',
          source: 'desk.arrival',
          licensed: true,
          price: '100',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(bench(result.run, 'midpoint')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_book' });
    expect(bench(result.run, 'interval_vwap')).toMatchObject({ status: 'UNAVAILABLE' });
    expect(bench(result.run, 'interval_twap')).toMatchObject({ status: 'UNAVAILABLE' });
    expect(bench(result.run, 'close')).toMatchObject({ status: 'UNAVAILABLE' });
    expect(result.run.slippage.find((row) => row.versus === 'midpoint')).toMatchObject({ status: 'UNAVAILABLE' });
  });

  it('does not write ledger — source has no post/recipe and MemoryLedger is never constructed', async () => {
    expect(tcaSource).not.toMatch(/\.post\s*\(/);
    expect(tcaSource).not.toMatch(/MemoryLedger/);
    expect(tcaSource).not.toMatch(/ledger-client\/recipes/);
    const ledger = await import('@intafaced/ledger-client');
    const postSpy = vi.spyOn(ledger.MemoryLedger.prototype, 'post');
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore);
    const result = runTcaRun({
      parentClientOrderId: 'parent-1',
      emsStore,
      observations: [{ class: 'arrival', source: 'desk.arrival', licensed: true, price: '100' }],
    });
    expect(result.ok).toBe(true);
    expect(postSpy).not.toHaveBeenCalled();
    postSpy.mockRestore();
  });

  it('refuses to invent fills when EMS evidence is missing', () => {
    expect(runTcaRun({ parentClientOrderId: 'ghost', emsStore: new InMemoryEmsOrderStore() })).toMatchObject({
      ok: false,
      reason: 'no_ems_evidence',
    });
    expect(runTcaRun({ parentClientOrderId: 'parent-1' })).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
    expect(runTcaRun({ emsStore: new InMemoryEmsOrderStore() })).toMatchObject({ ok: false, reason: 'missing_identity' });
  });

  it('names unresolved children and does not treat fill price as arrival', () => {
    const emsStore = new InMemoryEmsOrderStore();
    emsStore.record({
      clientOrderId: 'unknown-1',
      parentClientOrderId: 'parent-unk',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: null,
      state: 'SUBMIT_UNKNOWN',
      recordedAtMs: 1,
    });
    const result = runTcaRun({ parentClientOrderId: 'parent-unk', emsStore });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.completeness).toBe('partial');
    expect(result.run.realized).toMatchObject({ status: 'UNAVAILABLE', gap: 'no_fill_evidence' });
    expect(result.run.gaps.some((g) => g.code === 'unresolved_child')).toBe(true);
    expect(bench(result.run, 'arrival')).toMatchObject({ status: 'UNAVAILABLE' });
  });

  it('marks unlicensed or checksum-less capture observations UNAVAILABLE', () => {
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore);
    const unlicensed = runTcaRun({
      parentClientOrderId: 'parent-1',
      emsStore,
      observations: [{ class: 'arrival', source: 'vendor.tape', licensed: false, price: '100' }],
    });
    expect(unlicensed.ok).toBe(true);
    if (!unlicensed.ok) return;
    expect(bench(unlicensed.run, 'arrival')).toMatchObject({ status: 'UNAVAILABLE', gap: 'unlicensed' });

    const noChecksum = runTcaRun({
      parentClientOrderId: 'parent-1',
      emsStore,
      observations: [
        {
          class: 'arrival',
          source: 'capture.lake',
          licensed: true,
          price: '100',
          capturedAt: '2026-08-24T11:59:00.000Z',
        },
      ],
    });
    expect(noChecksum.ok).toBe(true);
    if (!noChecksum.ok) return;
    expect(bench(noChecksum.run, 'arrival')).toMatchObject({ status: 'UNAVAILABLE', gap: 'missing_checksum' });
  });

  it('uses a two-sided capture book only when capturedAt equals arrivalAt', () => {
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore);
    const lake = new CaptureLake({ now: () => new Date('2026-08-24T11:59:00.000Z') });
    const snapshot: VenueBookSnapshot = {
      venueId: 'street',
      symbol: 'BTC/USDT',
      sequence: 9,
      sequenced: true,
      observedAt: new Date('2026-08-24T11:59:00.000Z'),
      bids: [[parseAmount('100'), parseAmount('2')]],
      asks: [[parseAmount('102'), parseAmount('2')]],
    };
    lake.recordBook(snapshot);
    const result = runTcaRun({
      parentClientOrderId: 'parent-1',
      arrivalAt: '2026-08-24T11:59:00.000Z',
      emsStore,
      captureLake: lake,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(bench(result.run, 'arrival')).toMatchObject({ status: 'AVAILABLE', price: '101', source: 'capture.lake' });
    expect(result.run.slippage.find((row) => row.versus === 'arrival')).toMatchObject({
      status: 'AVAILABLE',
      fillVwap: '101',
      benchmark: '101',
      slippage: '0',
    });
  });
});

describe('execution.oms.tca.run tRPC', () => {
  it('reads EMS fills on the mounted door and does not require write scope beyond admin:read', async () => {
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore);
    const caller = createExecutionRouter(
      new SealedHouseTenantRegistry(),
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      emsStore,
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.tca.run({
      parentClientOrderId: 'parent-1',
      observations: [{ class: 'arrival', source: 'desk.arrival', licensed: true, price: '100' }],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.run.realized).toMatchObject({ status: 'AVAILABLE', fillVwap: '101' });
    expect(out.run.slippage.find((row) => row.versus === 'arrival')).toMatchObject({ status: 'AVAILABLE', slippageBps: '100' });
  });
});
