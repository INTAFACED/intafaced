/**
 * H-stress HTTP: halt ≡ cancel-only. Restart does not invent OPEN.
 * Bounded hermetic burst / cancel-storm. Not a certified capacity number.
 * Qty/price stay decimal strings. Do not invent owner SLOs.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { parseAmount, sum } from '@intafaced/ledger-client/money';
import { MatchingEngine } from './engine/engine.js';
import { MARKET_HALTED } from './engine/halt.js';
import { HALT_RESTART_OPEN, installHaltLaw } from './engine/halt-law.js';
import { FileJournal, MemoryJournal } from './engine/journal.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import type { MarketHaltResult } from './engine/types.js';

installHaltLaw();

const SECRET = 'matching-h-stress-halt-capacity-secret32';
const MARKET = 'BTC-USDT';
const REST = '11111111-1111-4111-8111-111111111111';
const PLACE = '22222222-2222-4222-8222-222222222222';
const AFTER = '44444444-4444-4444-8444-444444444444';
const TAKE = '55555555-5555-4555-8555-555555555555';

/** Bounded N. Not an SLO and not a certified capacity. */
const STORM_N = 24;
const CLIP = '0.25';

type HaltLawEngine = MatchingEngine & {
  restart(marketId: string): Promise<MarketHaltResult>;
};

function proofFor() {
  const observedAt = '2026-09-04T16:00:00.000Z';
  return createMarketLifecycleAdmissionProof(
    {
      marketId: MARKET,
      ruleVersion: 'test.rules.v1',
      instrumentId: MARKET,
      instrumentVersion: 'test.instrument.v1',
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: observedAt,
      observedAt,
      lastGoodState: 'OPEN',
      allowedActions: ['PLACE', 'PLACE_POST_ONLY'],
      transitionId: 'test.transition',
      evidenceRefs: ['test.evidence'],
    },
    'PLACE',
  );
}

function submitBody(over: Record<string, unknown> = {}) {
  return {
    orderId: REST,
    accountId: 'desk',
    type: 'limit' as const,
    side: 'sell' as const,
    qty: '1.25',
    price: '100',
    tif: 'GTC' as const,
    lifecycleProof: proofFor(),
    ...over,
  };
}

function oid(n: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`;
}

async function mount(engine: MatchingEngine): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, {
    bodyBind: 'require',
    approvals: stubApprovalConsumer('ops-confirm'),
    operatorIds: new Set(['ops-1', 'ops-confirm']),
  });
  await app.ready();
  return app;
}

function liveEngine(journal: MemoryJournal | FileJournal): HaltLawEngine {
  return new MatchingEngine({
    journal,
    bus: new MemoryEventBus('svc-matching'),
    snapshotEvery: 0,
  }) as HaltLawEngine;
}

function post(app: FastifyInstance, url: string, payloadBody: unknown) {
  const payload = JSON.stringify(payloadBody);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
    payload,
  });
}

function del(app: FastifyInstance, url: string) {
  const payload = '';
  return app.inject({
    method: 'DELETE',
    url,
    headers: { ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
  });
}

function getOrders(app: FastifyInstance) {
  return app.inject({
    method: 'GET',
    url: `/markets/${MARKET}/orders?limit=50`,
    headers: { ...serviceAuthHeadersForBody('svc-trade', SECRET, '') },
  });
}

function liveIds(appBody: { orders: readonly { orderId: string }[] }): string[] {
  return appBody.orders.map((row) => row.orderId).sort();
}

describe('H-stress HTTP — halt refuses PLACE, cancel stays, restart is not OPEN', () => {
  it('halt refuses PLACE and still cancels the rest', async () => {
    const engine = liveEngine(new MemoryJournal());
    const app = await mount(engine);

    const rest = await post(app, `/markets/${MARKET}/orders`, submitBody());
    expect(rest.statusCode).toBe(200);
    expect(rest.json().accepted).toBe(true);
    expect(typeof rest.json().resting.remaining).toBe('string');
    expect(rest.json().resting.remaining).toBe('1.25');

    const halt = await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(halt.statusCode).toBe(200);
    expect(halt.json()).toMatchObject({ accepted: true, halted: true, operatorId: 'ops-1', confirmOperatorId: 'ops-confirm' });
    expect(halt.json()).not.toHaveProperty('duration');
    expect(halt.json()).not.toHaveProperty('slo');
    expect(halt.json()).not.toHaveProperty('capacity');

    const listed = await getOrders(app);
    expect(liveIds(listed.json())).toEqual([REST]);

    const refused = await post(app, `/markets/${MARKET}/orders`, submitBody({ orderId: PLACE, accountId: 'taker', side: 'buy' }));
    expect(refused.statusCode).toBe(200);
    expect(refused.json().accepted).toBe(false);
    expect(refused.json().rejected.code).toBe(MARKET_HALTED);
    expect(refused.json().fills).toEqual([]);
    expect(refused.json().resting).toBeNull();

    const cancelled = await del(app, `/markets/${MARKET}/orders/${REST}`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().cancelled).toBe(true);

    const empty = await getOrders(app);
    expect(liveIds(empty.json())).toEqual([]);
    await app.close();
  });

  it('process remount and engine.restart stay halted — do not invent OPEN', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'matching-h-stress-halt-')), 'engine.ndjson');
    const liveJournal = new FileJournal(path);
    const live = liveEngine(liveJournal);
    const app = await mount(live);

    expect((await post(app, `/markets/${MARKET}/orders`, submitBody())).json().accepted).toBe(true);
    expect(
      (
        await post(app, `/markets/${MARKET}/halt`, {
          operatorId: 'ops-1',
          confirmOperatorId: 'ops-2',
          approvalId: 'appr-1',
          operationId: 'op-1',
        })
      ).json().accepted,
    ).toBe(true);

    await app.close();
    liveJournal.close();

    const recoveredJournal = new FileJournal(path);
    const recovered = liveEngine(recoveredJournal);
    recovered.recover();
    const remounted = await mount(recovered);

    const depth = await remounted.inject({ method: 'GET', url: `/markets/${MARKET}/depth?limit=50` });
    expect(depth.statusCode).toBe(200);
    expect(depth.json()).toMatchObject({ marketId: MARKET, halted: true });

    const blocked = await post(remounted, `/markets/${MARKET}/orders`, submitBody({ orderId: PLACE, accountId: 'taker', side: 'buy' }));
    expect(blocked.json().accepted).toBe(false);
    expect(blocked.json().rejected.code).toBe(MARKET_HALTED);
    expect(blocked.json().fills).toEqual([]);

    const restart = await recovered.restart(MARKET);
    expect(restart.accepted).toBe(false);
    expect(restart.rejected?.code).toBe(HALT_RESTART_OPEN);
    expect(restart.halted).toBe(true);
    expect(recovered.isHalted(MARKET)).toBe(true);

    const still = await post(remounted, `/markets/${MARKET}/orders`, submitBody({ orderId: AFTER, accountId: 'taker', side: 'buy' }));
    expect(still.json().accepted).toBe(false);
    expect(still.json().rejected.code).toBe(MARKET_HALTED);

    const listed = await getOrders(remounted);
    expect(liveIds(listed.json())).toEqual([REST]);
    expect(typeof listed.json().orders[0].remaining).toBe('string');
    expect(listed.json().orders[0].remaining).toBe('1.25');

    const cancelled = await del(remounted, `/markets/${MARKET}/orders/${REST}`);
    expect(cancelled.json().cancelled).toBe(true);

    const resume = await post(remounted, `/markets/${MARKET}/resume`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-confirm',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(resume.json()).toMatchObject({ accepted: true, halted: false });

    const open = await post(
      remounted,
      `/markets/${MARKET}/orders`,
      submitBody({ orderId: AFTER, accountId: 'mm', qty: '0.5', price: '99' }),
    );
    expect(open.json().accepted).toBe(true);
    expect(open.json().fills).toEqual([]);

    await remounted.close();
    recoveredJournal.close();
  });
});

describe('H-stress HTTP — bounded burst / cancel-storm (not certified capacity)', () => {
  it('cancel-storm of N rests leaves none live and invents no fill', async () => {
    const engine = liveEngine(new MemoryJournal());
    const app = await mount(engine);
    const ids = Array.from({ length: STORM_N }, (_, i) => oid(i + 1));

    for (const [i, orderId] of ids.entries()) {
      const placed = await post(app, `/markets/${MARKET}/orders`, submitBody({ orderId, accountId: `mm-${i}`, qty: CLIP, price: '101' }));
      expect(placed.statusCode).toBe(200);
      expect(placed.json().accepted).toBe(true);
      expect(placed.json().fills).toEqual([]);
      expect(typeof placed.json().resting.remaining).toBe('string');
      expect(placed.json().resting.remaining).toBe(CLIP);
    }

    const listed = await getOrders(app);
    expect(liveIds(listed.json())).toEqual([...ids].sort());
    expect(new Set(liveIds(listed.json())).size).toBe(STORM_N);

    for (const orderId of ids) {
      const cancelled = await del(app, `/markets/${MARKET}/orders/${orderId}`);
      expect(cancelled.json().cancelled).toBe(true);
    }

    const empty = await getOrders(app);
    expect(liveIds(empty.json())).toEqual([]);

    const take = await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody({ orderId: TAKE, accountId: 'taker', side: 'buy', qty: '6', price: '101' }),
    );
    expect(take.statusCode).toBe(200);
    expect(take.json().accepted).toBe(true);
    expect(take.json().fills).toEqual([]);
    expect(take.json().resting).toMatchObject({ orderId: TAKE, remaining: '6', price: '101' });
    expect(typeof take.json().resting.remaining).toBe('string');
    expect(liveIds((await getOrders(app)).json())).toEqual([TAKE]);
    await app.close();
  });

  it('burst of N clips fills the taker once each — no double-live, no invented qty', async () => {
    const engine = liveEngine(new MemoryJournal());
    const app = await mount(engine);
    const ids = Array.from({ length: STORM_N }, (_, i) => oid(i + 1));

    for (const [i, orderId] of ids.entries()) {
      const placed = await post(app, `/markets/${MARKET}/orders`, submitBody({ orderId, accountId: `mm-${i}`, qty: CLIP, price: '100' }));
      expect(placed.json().accepted).toBe(true);
      expect(placed.json().fills).toEqual([]);
    }

    const take = await post(
      app,
      `/markets/${MARKET}/orders`,
      submitBody({ orderId: TAKE, accountId: 'taker', side: 'buy', qty: '6', price: '100' }),
    );
    expect(take.statusCode).toBe(200);
    expect(take.json().accepted).toBe(true);
    expect(take.json().resting).toBeNull();

    const fills = take.json().fills as readonly { makerOrderId: string; takerOrderId: string; qty: string; price: string }[];
    expect(fills).toHaveLength(STORM_N);
    expect(fills.every((fill) => fill.takerOrderId === TAKE)).toBe(true);
    expect(fills.every((fill) => fill.qty === CLIP)).toBe(true);
    expect(fills.every((fill) => fill.price === '100')).toBe(true);
    expect(fills.every((fill) => typeof fill.qty === 'string' && typeof fill.price === 'string')).toBe(true);
    expect(sum(fills.map((fill) => parseAmount(fill.qty)))).toEqual(parseAmount('6'));
    expect(new Set(fills.map((fill) => fill.makerOrderId)).size).toBe(STORM_N);
    expect(fills.map((fill) => fill.makerOrderId).sort()).toEqual([...ids].sort());

    const listed = await getOrders(app);
    expect(liveIds(listed.json())).toEqual([]);
    await app.close();
  });
});
