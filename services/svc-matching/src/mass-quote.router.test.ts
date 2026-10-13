/**
 * H5 HTTP door: POST /markets/:marketId/mass-quote.
 * Paired-side reject (PTX-M11-R11). MMP fields may exist; blank magnitudes refuse.
 * Matching stays the book. Magnitudes stay unset — never invent 0/qty/delta/vega.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { createMarketLifecycleAdmissionProof, type MarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { QUOTE_PAIR_INCOMPLETE, QUOTE_PAIR_REJECTED, QUOTE_SET_MISSING } from './engine/mass-quote.js';
import { MMP_SIDECAR_REFUSED, MMP_UNPUBLISHED } from './engine/mmp.js';
import { registerRoutes } from './router.js';

const SECRET = 'matching-mass-quote-router-secret-32';
const MARKET = 'BTC-USDT';
const SET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BID = '11111111-1111-4111-8111-111111111111';
const ASK = '22222222-2222-4222-8222-222222222222';

function proofFor(marketId = MARKET, action: 'PLACE' | 'PLACE_POST_ONLY' = 'PLACE') {
  const observedAt = '2026-09-03T16:00:00.000Z';
  return createMarketLifecycleAdmissionProof(
    {
      marketId,
      ruleVersion: 'test.rules.v1',
      instrumentId: marketId,
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
    action,
  );
}

function side(orderId: string, qty: string, price: string | null, over: Record<string, unknown> = {}) {
  return {
    orderId,
    type: 'limit' as const,
    qty,
    price,
    tif: 'GTC' as const,
    ...over,
  };
}

function quoteBody(over: Record<string, unknown> = {}) {
  return {
    setId: SET,
    accountId: 'desk',
    bid: side(BID, '1', '99'),
    ask: side(ASK, '1', '101'),
    lifecycleProof: proofFor(),
    ...over,
  };
}

async function mount(): Promise<{ app: FastifyInstance; engine: MatchingEngine; journal: MemoryJournal }> {
  const journal = new MemoryJournal();
  const engine = new MatchingEngine({
    journal,
    bus: new MemoryEventBus('svc-matching'),
    snapshotEvery: 0,
  });
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, { bodyBind: 'require' });
  await app.ready();
  return { app, engine, journal };
}

function watchSubmits(engine: MatchingEngine): Array<MarketLifecycleAdmissionProof | undefined> {
  const proofs: Array<MarketLifecycleAdmissionProof | undefined> = [];
  const orig = engine.submit.bind(engine);
  engine.submit = (async (marketId, order, lifecycleProof) => {
    proofs.push(lifecycleProof);
    return orig(marketId, order, lifecycleProof);
  }) as typeof engine.submit;
  return proofs;
}

function journalProofs(journal: MemoryJournal): unknown[] {
  return journal.read().flatMap((record) => (record.kind === 'submit' ? [record.order.lifecycleProof] : []));
}

function post(app: FastifyInstance, payloadBody: unknown) {
  const payload = JSON.stringify(payloadBody);
  return app.inject({
    method: 'POST',
    url: `/markets/${MARKET}/mass-quote`,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
    payload,
  });
}

function liveIds(engine: MatchingEngine): string[] {
  return engine.restingOrders(MARKET).map((row) => row.orderId);
}

function inventedZero(body: Record<string, unknown>): boolean {
  const keys = ['maxQuote', 'maxPosition', 'maxLoss', 'delta', 'vega', 'qty', 'band', 'max'];
  return keys.some((key) => body[key] === 0 || body[key] === '0');
}

describe('POST /markets/:marketId/mass-quote', () => {
  it('two-sided set applies both rests as decimal-string qty', async () => {
    const { app, engine } = await mount();
    const res = await post(app, quoteBody());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.setId).toBe(SET);
    expect(body.oneSided).toBe(false);
    expect(body.rejected).toBeNull();
    expect(body.results.map((row: { status: string }) => row.status)).toEqual(['APPLIED', 'APPLIED']);
    expect(liveIds(engine).sort()).toEqual([ASK, BID].sort());
    expect(engine.restingOrders(MARKET).every((row) => row.remaining === '1')).toBe(true);
    expect(typeof engine.restingOrders(MARKET)[0]!.remaining).toBe('string');
    await app.close();
  });

  it('PTX-M11-R11: ask missing price unwinds bid — pair refused, book empty', async () => {
    const { app, engine } = await mount();
    const res = await post(app, quoteBody({ ask: side(ASK, '1', null) }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rejected.code).toBe(QUOTE_PAIR_REJECTED);
    expect(body.results.map((row: { status: string }) => row.status)).toEqual(['REFUSED', 'REFUSED']);
    expect(body.results[0].rejected.code).toBe(QUOTE_PAIR_REJECTED);
    expect(body.results[1].rejected.code).toBe('missing_price');
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('missing ask on two-sided refuses quote_pair_incomplete — nothing rests', async () => {
    const { app, engine } = await mount();
    const res = await post(app, quoteBody({ ask: null }));
    expect(res.statusCode).toBe(200);
    expect(res.json().rejected.code).toBe(QUOTE_PAIR_INCOMPLETE);
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('empty setId refuses quote_set_missing — setId not invented', async () => {
    const { app, engine } = await mount();
    const res = await post(app, quoteBody({ setId: '' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().setId).toBeNull();
    expect(res.json().rejected.code).toBe(QUOTE_SET_MISSING);
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('mmp:true with unset magnitudes refuses unpublished; book empty; no invented 0', async () => {
    const { app, engine } = await mount();
    const res = await post(app, quoteBody({ mmp: true }));
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown> & {
      results: Array<{ status: string; rejected: { code: string } | null }>;
      rejected: { code: string } | null;
    };
    expect(body.rejected?.code).toBe(QUOTE_PAIR_REJECTED);
    expect(body.results.every((row) => row.status === 'REFUSED')).toBe(true);
    expect(body.results.every((row) => row.rejected?.code === MMP_UNPUBLISHED)).toBe(true);
    expect(inventedZero(body)).toBe(false);
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('blank mmpMaxQuote/delta/vega still unpublished — never become 0', async () => {
    const { app, engine } = await mount();
    const res = await post(
      app,
      quoteBody({
        mmpMaxQuote: '',
        mmpMaxDelta: '',
        mmpMaxVega: '',
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.every((row: { rejected: { code: string } }) => row.rejected.code === MMP_UNPUBLISHED)).toBe(true);
    expect(inventedZero(body)).toBe(false);
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('stated mmpMaxQuote decimal is still unpublished — not a live max', async () => {
    const { app, engine } = await mount();
    const res = await post(app, quoteBody({ mmpMaxQuote: '1' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].rejected.code).toBe(MMP_UNPUBLISHED);
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('ask-only MMP refuses the pair and unwinds the applied bid', async () => {
    const { app, engine } = await mount();
    const res = await post(app, quoteBody({ ask: side(ASK, '1', '101', { mmp: true }) }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rejected.code).toBe(QUOTE_PAIR_REJECTED);
    expect(body.results[0].rejected.code).toBe(QUOTE_PAIR_REJECTED);
    expect(body.results[1].rejected.code).toBe(MMP_UNPUBLISHED);
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('sidecar MM refuses mmp_sidecar_refused', async () => {
    const { app, engine } = await mount();
    const res = await post(app, quoteBody({ sidecar: true }));
    expect(res.statusCode).toBe(200);
    expect(res.json().results.every((row: { rejected: { code: string } }) => row.rejected.code === MMP_SIDECAR_REFUSED)).toBe(true);
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('JSON number qty is 400 — amounts stay decimal strings', async () => {
    const { app, engine } = await mount();
    const res = await post(app, quoteBody({ bid: { ...side(BID, '1', '99'), qty: 1 } }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('JSON number mmpMaxQuote is 400 — never a live 0', async () => {
    const { app } = await mount();
    const res = await post(app, quoteBody({ mmpMaxQuote: 0 }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    await app.close();
  });

  it('unsigned request is 401 — engine never called', async () => {
    const { app, engine } = await mount();
    const res = await app.inject({
      method: 'POST',
      url: `/markets/${MARKET}/mass-quote`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(quoteBody()),
    });
    expect(res.statusCode).toBe(401);
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('forwards the parsed lifecycle proof into each side submit', async () => {
    const { app, engine, journal } = await mount();
    const proof = proofFor();
    const seen = watchSubmits(engine);
    const res = await post(app, quoteBody({ lifecycleProof: proof }));
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(proof);
    expect(seen[1]).toBe(seen[0]);
    expect(journalProofs(journal)).toEqual([seen[0], seen[0]]);
    await app.close();
  });

  it('one-sided quote submits only the given side with that same proof', async () => {
    const { app, engine, journal } = await mount();
    const proof = proofFor();
    const seen = watchSubmits(engine);
    const res = await post(app, quoteBody({ oneSided: true, ask: null, lifecycleProof: proof }));
    expect(res.statusCode).toBe(200);
    expect(res.json().oneSided).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(proof);
    expect(journalProofs(journal)).toEqual([seen[0]]);
    expect(liveIds(engine)).toEqual([BID]);
    await app.close();
  });

  it('omitting lifecycleProof fails the schema and does not submit', async () => {
    const { app, engine, journal } = await mount();
    const seen = watchSubmits(engine);
    const body: Record<string, unknown> = { ...quoteBody() };
    delete body.lifecycleProof;
    const res = await post(app, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(res.json().issues.join('\n')).toContain('lifecycleProof');
    expect(seen).toEqual([]);
    expect(journal.read()).toEqual([]);
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('a proof for another market is 400 and does not quote', async () => {
    const { app, engine, journal } = await mount();
    const seen = watchSubmits(engine);
    const res = await post(app, quoteBody({ lifecycleProof: proofFor('ETH-USDT') }));
    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toContain('lifecycleProof.snapshot.marketId: must match the route marketId');
    expect(seen).toEqual([]);
    expect(journal.read()).toEqual([]);
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('a non-PLACE proof is 400 and does not quote', async () => {
    const { app, engine, journal } = await mount();
    const seen = watchSubmits(engine);
    const res = await post(app, quoteBody({ lifecycleProof: proofFor(MARKET, 'PLACE_POST_ONLY') }));
    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toContain('lifecycleProof.action: must be PLACE for this quote set');
    expect(seen).toEqual([]);
    expect(journal.read()).toEqual([]);
    expect(liveIds(engine)).toEqual([]);
    await app.close();
  });

  it('pair-incomplete and missing setId refuse without submit', async () => {
    const incomplete = await mount();
    const incompleteSeen = watchSubmits(incomplete.engine);
    const missingAsk = await post(incomplete.app, quoteBody({ ask: null }));
    expect(missingAsk.statusCode).toBe(200);
    expect(missingAsk.json().rejected.code).toBe(QUOTE_PAIR_INCOMPLETE);
    expect(incompleteSeen).toEqual([]);
    expect(incomplete.journal.read()).toEqual([]);
    await incomplete.app.close();

    const missingSet = await mount();
    const missingSetSeen = watchSubmits(missingSet.engine);
    const emptySet = await post(missingSet.app, quoteBody({ setId: '' }));
    expect(emptySet.statusCode).toBe(200);
    expect(emptySet.json().rejected.code).toBe(QUOTE_SET_MISSING);
    expect(missingSetSeen).toEqual([]);
    expect(missingSet.journal.read()).toEqual([]);
    await missingSet.app.close();
  });
});
