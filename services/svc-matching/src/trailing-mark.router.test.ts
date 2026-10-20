import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerRoutes } from './router.js';

/**
 * HTTP door that walks trailing stops with a server-side mark. The peak only ratchets and the trigger only
 * tightens, so a repeated or older mark changes nothing; a mark that moved something is journaled and replays.
 */

const SECRET = 'matching-trailing-mark-router-secret-32chr';
const MARKET = 'BTC-USDT';
const SELL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BUY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function proofFor() {
  const observedAt = '2026-08-25T16:00:00.000Z';
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

function newEngine(journal: MemoryJournal): MatchingEngine {
  return new MatchingEngine({ journal, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
}

async function mount(journal = new MemoryJournal()): Promise<{ app: FastifyInstance; engine: MatchingEngine; journal: MemoryJournal }> {
  const engine = newEngine(journal);
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, { bodyBind: 'require' });
  await app.ready();
  return { app, engine, journal };
}

function post(app: FastifyInstance, url: string, payloadBody: unknown, signed = true) {
  const payload = JSON.stringify(payloadBody);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...(signed ? serviceAuthHeadersForBody('svc-trade', SECRET, payload) : {}) },
    payload,
  });
}

const place = (app: FastifyInstance, over: Record<string, unknown> = {}) =>
  post(app, `/markets/${MARKET}/orders`, {
    orderId: SELL,
    accountId: 'desk',
    type: 'stop',
    side: 'sell',
    qty: '2',
    tif: 'GTC',
    trail: '5',
    mark: '100',
    lifecycleProof: proofFor(),
    ...over,
  });

const mark = (app: FastifyInstance, value: unknown, marketId = MARKET) => post(app, `/markets/${marketId}/mark`, { mark: value });
const marks = (journal: MemoryJournal) => journal.read().filter((r) => r.kind === 'mark');
const stopOf = (engine: MatchingEngine, orderId = SELL) =>
  engine
    .book(MARKET)
    .toState()
    .stops.find((s) => s.orderId === orderId)!.stopPrice;

describe('POST /markets/:marketId/mark', () => {
  it('walks a sell trailing stop up with the mark and journals the move', async () => {
    const { app, engine, journal } = await mount();
    expect((await place(app)).json().accepted).toBe(true);
    expect(stopOf(engine)).toBe('95');
    const res = await mark(app, '110');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: true, applied: true, rejected: null });
    expect(stopOf(engine)).toBe('105');
    expect(marks(journal)).toHaveLength(1);
    await app.close();
  });

  it('walks a buy trailing stop down with the mark', async () => {
    const { app, engine } = await mount();
    expect((await place(app, { orderId: BUY, side: 'buy', mark: '100' })).json().accepted).toBe(true);
    expect(stopOf(engine, BUY)).toBe('105');
    expect((await mark(app, '90')).json().applied).toBe(true);
    expect(stopOf(engine, BUY)).toBe('95');
    await app.close();
  });

  it('a lower mark does not walk the stop back and writes nothing', async () => {
    const { app, engine, journal } = await mount();
    await place(app);
    await mark(app, '110');
    const before = journal.length;
    const res = await mark(app, '90');
    expect(res.json()).toEqual({ accepted: true, applied: false, rejected: null });
    expect(stopOf(engine)).toBe('105');
    expect(journal.length).toBe(before);
    await app.close();
  });

  it('the same mark twice changes and journals nothing the second time', async () => {
    const { app, engine, journal } = await mount();
    await place(app);
    await mark(app, '110');
    const before = journal.length;
    const again = await mark(app, '110');
    expect(again.json().applied).toBe(false);
    expect(stopOf(engine)).toBe('105');
    expect(journal.length).toBe(before);
    await app.close();
  });

  it('a restart replays the journaled marks to the same trigger and the same peak', async () => {
    const first = await mount();
    await place(first.app);
    await mark(first.app, '110');
    await mark(first.app, '120');
    expect(stopOf(first.engine)).toBe('115');
    await first.app.close();

    const second = await mount(first.journal);
    await second.engine.recover();
    expect(stopOf(second.engine)).toBe('115');
    // The peak survived: a lower mark after the restart still does not walk it back.
    expect((await mark(second.app, '100')).json().applied).toBe(false);
    expect(stopOf(second.engine)).toBe('115');
    // And a higher one still ratchets from the replayed peak.
    expect((await mark(second.app, '130')).json().applied).toBe(true);
    expect(stopOf(second.engine)).toBe('125');
    await second.app.close();
  });

  it('refuses a blank, malformed or zero mark; the engine never invents one', async () => {
    const { app, engine, journal } = await mount();
    await place(app);
    const before = journal.length;
    for (const bad of ['', 'abc', '-5', '1e3', 110]) {
      expect((await mark(app, bad)).statusCode).toBe(400);
    }
    const zero = await mark(app, '0');
    expect(zero.statusCode).toBe(200);
    expect(zero.json()).toMatchObject({ accepted: false, applied: false, rejected: { code: 'missing_mark' } });
    expect((await post(app, `/markets/${MARKET}/mark`, {})).statusCode).toBe(400);
    expect(stopOf(engine)).toBe('95');
    expect(journal.length).toBe(before);
    await app.close();
  });

  it('refuses on a halted market and moves nothing', async () => {
    const { app, engine, journal } = await mount();
    await place(app);
    expect((await engine.halt(MARKET, { operatorId: 'op-a', confirmOperatorId: 'op-b' })).accepted).toBe(true);
    const before = journal.length;
    const res = await mark(app, '110');
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(false);
    expect(res.json().applied).toBe(false);
    expect(stopOf(engine)).toBe('95');
    expect(journal.length).toBe(before);
    await app.close();
  });

  it('a market with no book accepts the mark and does nothing', async () => {
    const { app, journal } = await mount();
    const res = await mark(app, '110', 'ETH-USDT');
    expect(res.json()).toEqual({ accepted: true, applied: false, rejected: null });
    expect(journal.length).toBe(0);
    await app.close();
  });

  it('a plain resting stop (no trail) is not moved by a mark', async () => {
    const { app, engine, journal } = await mount();
    const placed = await place(app, { trail: undefined, mark: undefined, stopPrice: '95', price: null });
    expect(placed.statusCode).toBe(200);
    const before = journal.length;
    expect((await mark(app, '200')).json().applied).toBe(false);
    expect(journal.length).toBe(before);
    expect(
      engine
        .book(MARKET)
        .toState()
        .stops.every((s) => s.stopPrice !== '195'),
    ).toBe(true);
    await app.close();
  });

  it('an unsigned request is refused', async () => {
    const { app, journal } = await mount();
    const res = await post(app, `/markets/${MARKET}/mark`, { mark: '110' }, false);
    expect([401, 403]).toContain(res.statusCode);
    expect(journal.length).toBe(0);
    await app.close();
  });
});
