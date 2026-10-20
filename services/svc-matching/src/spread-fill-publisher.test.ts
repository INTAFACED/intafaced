/**
 * The production spread-fill publisher (CB-otc-16). A spread fill through the real engine and the real HTTP door
 * reaches the bus as one catalog-valid `spreadFilled` envelope, keyed by the engine's journal key, with a negative
 * spread price intact. And `index.ts`, the file the container runs, wires it: without it every spread order refuses
 * `spread_fill_event_unwired`.
 *
 * Break: publish to another subject, drop a field the catalog requires, or remove the `spreadFills` line from
 * `index.ts`, and a test here fails.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { EVENT_CATALOG, MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { spreadFillPublisherFor } from './spread-fill-publisher.js';

const SECRET = 'matching-spread-publish-secret-32chars!!';
const CAL = 'BTC-CAL-MAR-JUN';
const NEAR = 'BTC-27MAR';
const FAR = 'BTC-26JUN';

const LISTING = {
  kind: 'calendar',
  legs: [
    { symbol: NEAR, side: 'sell', ratio: '1' },
    { symbol: FAR, side: 'buy', ratio: '1' },
  ],
  tick: '0.5',
  lot: '0.001',
  operatorId: 'ops-1',
  confirmOperatorId: 'ops-confirm',
  approvalId: 'appr-1',
  operationId: 'op-1',
};

function proof() {
  const observedAt = '2026-10-20T12:00:00.000Z';
  return createMarketLifecycleAdmissionProof(
    {
      marketId: CAL,
      ruleVersion: 'test.rules.v1',
      instrumentId: CAL,
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

async function mount() {
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({
    journal: new MemoryJournal(),
    bus,
    snapshotEvery: 0,
    spreadFills: spreadFillPublisherFor(bus),
  });
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, {
    bodyBind: 'require',
    approvals: stubApprovalConsumer('ops-confirm'),
    operatorIds: new Set(['ops-1', 'ops-confirm']),
  });
  await app.ready();
  const post = (url: string, body: unknown) => {
    const payload = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
      payload,
    });
  };
  return { app, bus, post };
}

function order(over: Record<string, unknown>) {
  return { qty: '2', tif: 'GTC', anchorReference: '60000', lifecycleProof: proof(), ...over };
}

describe('spreadFillPublisherFor: spread fills on matching.spread.filled', () => {
  it('a negative-price spread fill reaches the bus once, catalog-valid, keyed by the journal key', async () => {
    const { app, bus, post } = await mount();
    expect((await post(`/spreads/${CAL}/list`, LISTING)).statusCode).toBe(200);

    const maker = await post(
      `/spreads/${CAL}/orders`,
      order({ orderId: '11111111-1111-4111-8111-111111111111', accountId: 'mm', side: 'sell', price: '-25' }),
    );
    expect(maker.json()).toMatchObject({ accepted: true, resting: { price: '-25' } });
    const taker = await post(
      `/spreads/${CAL}/orders`,
      order({ orderId: '22222222-2222-4222-8222-222222222222', accountId: 'taker', side: 'buy', price: '-20' }),
    );
    expect(taker.statusCode).toBe(200);
    expect(taker.json().fills).toHaveLength(1);

    const sent = bus.emitted('spreadFilled');
    expect(sent).toHaveLength(1);
    const env = sent[0]!;
    expect(env.subject).toBe(EVENT_CATALOG.spreadFilled.subject);
    // The catalog schema is what svc-trade's consumer parses with; the envelope must pass it unchanged.
    expect(EVENT_CATALOG.spreadFilled.schema.parse(env.payload)).toEqual(env.payload);
    expect(env.payload).toMatchObject({
      spreadId: CAL,
      makerOrderId: '11111111-1111-4111-8111-111111111111',
      takerOrderId: '22222222-2222-4222-8222-222222222222',
      makerAccountId: 'mm',
      takerAccountId: 'taker',
      takerSide: 'buy',
      price: '-25',
      qty: '2',
      legs: [
        { symbol: NEAR, takerSide: 'sell', qty: '2', price: '60000' },
        { symbol: FAR, takerSide: 'buy', qty: '2', price: '59975' },
      ],
    });
    // No outright print for a spread fill: svc-trade must never settle it as an order.filled trade.
    expect(bus.emitted('orderFilled')).toHaveLength(0);
    // The envelope carries the engine's journal key, which the consumer dedupes on: a replay after a crash settles once.
    expect(env.idempotencyKey).toBe(`matching.spread.filled:${CAL}:${env.payload.sequence}`);
    await app.close();
  });

  it('index.ts, the file the container runs, wires the publisher into the engine', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const index = readFileSync(join(here, 'index.ts'), 'utf8');
    const engineBlock = index.slice(index.indexOf('new MatchingEngine({'), index.indexOf('});', index.indexOf('new MatchingEngine({')));
    expect(engineBlock).toContain('spreadFills: spreadFillPublisherFor(bus)');
  });
});
