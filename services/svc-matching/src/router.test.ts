import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { registerRoutes } from './router.js';
import { userCopy } from './user-copy.js';

// ── Order writes are service-only ────────────────────────────────────────────
//
// These routes had no authentication at all. Two consequences, and the first is
// the one that matters:
//
//   · An order the ledger never held funds for could be submitted straight to
//     the engine. svc-trade's design note — "svc-matching is allowed to be pure
//     precisely because it never sees an unfunded order" — was enforced by
//     nothing but the absence of anyone trying.
//   · Any resting order could be cancelled by id. The engine publishes
//     `orderCancelled`, svc-trade releases that user's hold. A for-loop over
//     ids empties a book.
//
// Mounted on a REAL Fastify instance, because `registerRoutes` now installs a
// content-type parser to retain the raw bytes, and a digest is only worth
// something if the bytes it is checked against are the ones Fastify received.

describe('order writes require service credentials', () => {
  const SECRET = 'matching-internal-service-secret-32c';

  async function mount(engine: unknown, options?: { bodyBind?: 'accept-both' | 'require' }) {
    const app = Fastify({ logger: false });
    registerRoutes(app, engine as never, SECRET, options ?? {});
    await app.ready();
    return app;
  }

  const validSubmit = {
    orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    accountId: 'acct-1',
    type: 'limit' as const,
    side: 'buy' as const,
    qty: '1.5',
    price: '30000',
    tif: 'GTC' as const,
    lifecycleProof: createMarketLifecycleAdmissionProof(
      {
        marketId: 'BTC-USDT',
        ruleVersion: 'test.rules.v1',
        instrumentId: 'BTC-USDT',
        instrumentVersion: 'test.instrument.v1',
        state: 'OPEN',
        reasonCategory: 'NORMAL',
        reasonCode: 'trade.lifecycle.ready',
        effectiveAt: '2026-08-24T16:00:00.000Z',
        observedAt: '2026-08-24T16:00:00.000Z',
        lastGoodState: 'OPEN',
        allowedActions: ['PLACE', 'PLACE_POST_ONLY'],
        transitionId: 'test.transition',
        evidenceRefs: ['test.evidence'],
      },
      'PLACE',
    ),
  };

  const submit = (app: FastifyInstance, headers: Record<string, string>, payload: string) =>
    app.inject({
      method: 'POST',
      url: '/markets/BTC-USDT/orders',
      headers: { 'content-type': 'application/json', ...headers },
      payload,
    });

  const cancel = (app: FastifyInstance, headers: Record<string, string>) =>
    app.inject({ method: 'DELETE', url: '/markets/m/orders/o', headers });

  const validAmend = {
    expectedVersion: 1,
    qty: '1',
    lifecycleProof: createMarketLifecycleAdmissionProof(
      {
        marketId: 'BTC-USDT',
        ruleVersion: 'test.rules.v1',
        instrumentId: 'BTC-USDT',
        instrumentVersion: 'test.instrument.v1',
        state: 'OPEN',
        reasonCategory: 'NORMAL',
        reasonCode: 'trade.lifecycle.ready',
        effectiveAt: '2026-08-24T16:00:00.000Z',
        observedAt: '2026-08-24T16:00:00.000Z',
        lastGoodState: 'OPEN',
        allowedActions: ['PLACE', 'PLACE_POST_ONLY', 'AMEND'],
        transitionId: 'test.transition',
        evidenceRefs: ['test.evidence'],
      },
      'AMEND',
    ),
  };

  const amend = (app: FastifyInstance, headers: Record<string, string>, payload: string) =>
    app.inject({
      method: 'PATCH',
      url: '/markets/BTC-USDT/orders/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      headers: { 'content-type': 'application/json', ...headers },
      payload,
    });

  it('refuses an unauthenticated submit, and the engine is never called', async () => {
    let submitted = false;
    const app = await mount({ submit: async () => ((submitted = true), { accepted: true }), markets: [] });

    const res = await submit(app, {}, JSON.stringify(validSubmit));

    expect(res.statusCode).toBe(401);
    expect(submitted).toBe(false);
    await app.close();
  });

  it('refuses an unauthenticated cancel, and the engine is never called', async () => {
    let cancelled = false;
    const app = await mount({ cancel: async () => ((cancelled = true), { cancelled: true }), markets: [] });

    const res = await cancel(app, {});

    expect(res.statusCode).toBe(401);
    expect(cancelled).toBe(false);
    await app.close();
  });

  it('refuses an unauthenticated amend, and the engine is never called', async () => {
    let amended = false;
    const app = await mount({ amend: async () => ((amended = true), { accepted: true }), markets: [] });

    const res = await amend(app, {}, JSON.stringify(validAmend));

    expect(res.statusCode).toBe(401);
    expect(amended).toBe(false);
    await app.close();
  });

  it('accepts a properly signed amend that binds its body', async () => {
    let cmd: unknown = null;
    const app = await mount({
      amend: async () => {
        cmd = true;
        return {
          accepted: true,
          orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sequence: 1,
          version: 2,
          priority: 'retained',
          fills: [],
          resting: null,
          cancellations: [],
          triggered: [],
        };
      },
      markets: [],
    });

    const payload = JSON.stringify(validAmend);
    const res = await amend(app, serviceAuthHeadersForBody('svc-trade', SECRET, payload), payload);

    expect(res.statusCode).toBe(200);
    expect(cmd).toBe(true);
    expect(res.json()).toMatchObject({ accepted: true, priority: 'retained', version: 2 });
    await app.close();
  });

  it('returns a stable 403 for an authenticated unmapped submit', async () => {
    let submitted = false;
    const app = await mount({ submit: async () => ((submitted = true), { accepted: true }), markets: [] });
    const payload = JSON.stringify(validSubmit);

    const res = await submit(app, serviceAuthHeadersForBody('svc-pay', SECRET, payload), payload);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'Forbidden', message: userCopy('error.forbidden') });
    expect(submitted).toBe(false);
    await app.close();
  });

  it('accepts a properly signed submit from svc-execution (basket children)', async () => {
    let submitted: unknown = null;
    const app = await mount({
      submit: async (_m: string, o: unknown) => {
        submitted = o;
        return { accepted: true, sequence: 1, fills: [], resting: null, cancellations: [], triggered: [] };
      },
      markets: [],
    });
    const payload = JSON.stringify(validSubmit);

    const res = await submit(app, serviceAuthHeadersForBody('svc-execution', SECRET, payload), payload);

    expect(res.statusCode).toBe(200);
    expect(submitted).not.toBeNull();
    await app.close();
  });

  it('returns a stable 403 for an authenticated unmapped cancel', async () => {
    let cancelled = false;
    const app = await mount({ cancel: async () => ((cancelled = true), { cancelled: true }), markets: [] });

    const res = await cancel(app, serviceAuthHeadersForBody('svc-pay', SECRET, ''));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'Forbidden', message: userCopy('error.forbidden') });
    expect(cancelled).toBe(false);
    await app.close();
  });

  it('accepts a properly signed cancel from svc-execution (basket children)', async () => {
    let cancelled = false;
    const app = await mount({
      cancel: async () => ((cancelled = true), { cancelled: true, orderId: 'o', sequence: 1, cancellation: null }),
      markets: [],
    });

    const res = await cancel(app, serviceAuthHeadersForBody('svc-execution', SECRET, ''));

    expect(res.statusCode).toBe(200);
    expect(cancelled).toBe(true);
    await app.close();
  });

  it('accepts a properly signed submit from svc-fix (NOS)', async () => {
    let submitted: unknown = null;
    const app = await mount({
      submit: async (_m: string, o: unknown) => {
        submitted = o;
        return { accepted: true, sequence: 1, fills: [], resting: null, cancellations: [], triggered: [] };
      },
      markets: [],
    });
    const payload = JSON.stringify(validSubmit);

    const res = await submit(app, serviceAuthHeadersForBody('svc-fix', SECRET, payload), payload);

    expect(res.statusCode).toBe(200);
    expect(submitted).not.toBeNull();
    await app.close();
  });

  it('refuses unsigned svc-fix submit as 401 — HMAC is not dropped', async () => {
    let submitted = false;
    const app = await mount({ submit: async () => ((submitted = true), { accepted: true }), markets: [] });
    const payload = JSON.stringify(validSubmit);

    const res = await submit(app, { 'x-intafaced-service': 'svc-fix' }, payload);

    expect(res.statusCode).toBe(401);
    expect(submitted).toBe(false);
    await app.close();
  });

  it('accepts a properly signed cancel from svc-fix', async () => {
    let cancelled = false;
    const app = await mount({
      cancel: async () => ((cancelled = true), { cancelled: true, orderId: 'o', sequence: 1, cancellation: null }),
      markets: [],
    });

    const res = await cancel(app, serviceAuthHeadersForBody('svc-fix', SECRET, ''));

    expect(res.statusCode).toBe(200);
    expect(cancelled).toBe(true);
    await app.close();
  });

  it('refuses a forged signature', async () => {
    const app = await mount({ cancel: async () => ({ cancelled: true }), markets: [] });

    const res = await cancel(app, {
      'x-intafaced-service': 'svc-trade',
      'x-intafaced-service-ts': String(Math.floor(Date.now() / 1000)),
      'x-intafaced-service-sig': 'a'.repeat(64),
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts a properly signed submit that binds its body', async () => {
    let submitted: unknown = null;
    const app = await mount({
      submit: async (_m: string, o: unknown) => {
        submitted = o;
        return { accepted: true, sequence: 1, fills: [], resting: null, cancellations: [], triggered: [] };
      },
      markets: [],
    });

    const payload = JSON.stringify(validSubmit);
    const res = await submit(app, serviceAuthHeadersForBody('svc-trade', SECRET, payload), payload);

    expect(res.statusCode).toBe(200);
    expect(submitted).not.toBeNull();
    await app.close();
  });

  /**
   * A bodyless request still binds — as the digest of the empty body. So the
   * cancel route cannot have a body bolted onto it, and its credentials cannot
   * be lifted onto the submit route.
   */
  it('accepts a properly signed cancel from svc-trade, binding the absent body', async () => {
    let cancelled = false;
    const app = await mount({
      cancel: async () => ((cancelled = true), { cancelled: true, orderId: 'o', sequence: 1, cancellation: null }),
      markets: [],
    });

    const res = await cancel(app, serviceAuthHeadersForBody('svc-trade', SECRET, ''));

    expect(res.statusCode).toBe(200);
    expect(cancelled).toBe(true);
    await app.close();
  });

  // ── L2-6: the replay this closes ───────────────────────────────────────────

  /**
   * THE TEST THE CHANGE EXISTS FOR, on the mounted path.
   *
   * svc-trade places the ledger hold and only then calls here, which is why the
   * engine is allowed to be pure. Credentials captured from one funded order,
   * replayed against a different one, broke that invariant from outside: the
   * engine would match an order svc-trade has no record of and no hold for.
   */
  it('refuses captured credentials replayed over a mutated order, and the engine is never called', async () => {
    let submitted = false;
    const app = await mount({
      submit: async () => ((submitted = true), { accepted: true, sequence: 1, fills: [], resting: null, cancellations: [], triggered: [] }),
      markets: [],
    });

    const honest = JSON.stringify(validSubmit);
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, honest);

    // Same credentials, 1000x the quantity.
    const tampered = JSON.stringify({ ...validSubmit, qty: '1500' });
    const res = await submit(app, headers, tampered);

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe(userCopy('matching.unauthenticated'));
    expect(res.json().rejected).toBe('body-mismatch');
    expect(submitted).toBe(false);
    await app.close();
  });

  it('refuses captured credentials replayed over a mutated lifecycle proof', async () => {
    let submitted = false;
    const app = await mount({
      submit: async () => ((submitted = true), { accepted: true, sequence: 1, fills: [], resting: null, cancellations: [], triggered: [] }),
      markets: [],
    });

    const honest = JSON.stringify(validSubmit);
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, honest);
    const tampered = JSON.stringify({
      ...validSubmit,
      lifecycleProof: { ...validSubmit.lifecycleProof, transitionId: 'tampered-after-signing' },
    });
    const res = await submit(app, headers, tampered);

    expect(res.statusCode).toBe(401);
    expect(res.json().rejected).toBe('body-mismatch');
    expect(submitted).toBe(false);
    await app.close();
  });

  it('refuses cancel credentials lifted onto a submit', async () => {
    let submitted = false;
    const app = await mount({
      submit: async () => ((submitted = true), { accepted: true, sequence: 1, fills: [], resting: null, cancellations: [], triggered: [] }),
      markets: [],
    });

    // Minted for the bodyless cancel, pointed at the write that carries a body.
    const res = await submit(app, serviceAuthHeadersForBody('svc-trade', SECRET, ''), JSON.stringify(validSubmit));

    expect(res.statusCode).toBe(401);
    expect(submitted).toBe(false);
    await app.close();
  });

  it('accept-both admits a legacy v1 submit — the migration window, not a second verify', async () => {
    let submitted = false;
    const app = await mount(
      {
        submit: async () => (
          (submitted = true),
          { accepted: true, sequence: 1, fills: [], resting: null, cancellations: [], triggered: [] }
        ),
        markets: [],
      },
      { bodyBind: 'accept-both' },
    );

    const res = await submit(app, serviceAuthHeaders('svc-trade', SECRET), JSON.stringify(validSubmit));

    expect(res.statusCode).toBe(200);
    expect(submitted).toBe(true);
    await app.close();
  });

  // ── The migration, both directions ─────────────────────────────────────────

  it('accept-both admits a legacy v1 caller on an empty-body private route too', async () => {
    const app = await mount(
      { cancel: async () => ({ cancelled: true, orderId: 'o', sequence: 1, cancellation: null }), markets: [] },
      { bodyBind: 'accept-both' },
    );

    const res = await cancel(app, serviceAuthHeaders('svc-trade', SECRET));

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('require refuses that same legacy caller, naming why — no accept-both retry', async () => {
    const app = await mount(
      { cancel: async () => ({ cancelled: true, orderId: 'o', sequence: 1, cancellation: null }), markets: [] },
      { bodyBind: 'require' },
    );

    const res = await cancel(app, serviceAuthHeaders('svc-trade', SECRET));

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe(userCopy('matching.unauthenticated'));
    expect(res.json().rejected).toBe('missing-body-digest');
    await app.close();
  });

  it('require refuses a v1 unmapped caller as 401, not 403 from a second verify', async () => {
    let submitted = false;
    const app = await mount({ submit: async () => ((submitted = true), { accepted: true }), markets: [] }, { bodyBind: 'require' });

    const res = await submit(app, serviceAuthHeaders('svc-pay', SECRET), JSON.stringify(validSubmit));

    expect(res.statusCode).toBe(401);
    expect(res.json().rejected).toBe('missing-body-digest');
    expect(submitted).toBe(false);
    await app.close();
  });

  it('require still admits a redeployed v2 caller — the destination state works', async () => {
    const app = await mount(
      { cancel: async () => ({ cancelled: true, orderId: 'o', sequence: 1, cancellation: null }), markets: [] },
      { bodyBind: 'require' },
    );

    const res = await cancel(app, serviceAuthHeadersForBody('svc-trade', SECRET, ''));

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // Depth and the market list stay open. A price is not a secret, and market
  // data being public is the point of a public market.
  it('leaves market data readable without credentials', async () => {
    const app = await mount({ depth: () => ({ bids: [], asks: [], sequence: 0 }), markets: [] });

    const res = await app.inject({ method: 'GET', url: '/markets/m/depth?limit=50' });
    const markets = await app.inject({ method: 'GET', url: '/markets' });

    expect(res.statusCode).toBe(200);
    expect(markets.statusCode).toBe(200);
    expect(markets.json()).toMatchObject({ markets: [] });
    await app.close();
  });
});

// ── Reading must not create ──────────────────────────────────────────────────

describe('depth does not allocate a book', () => {
  /**
   * `engine.depth()` went through `engine.book()`, which creates and STORES an
   * OrderBook for any market id it is handed. The depth route is unauthenticated
   * by design — a price is not a secret — so `GET /markets/<anything>/depth` was
   * an unbounded memory-growth primitive against the engine, drivable from any
   * browser the moment a public websocket existed.
   *
   * Found while building svc-ws, which guards its own path by validating
   * against `GET /markets`. That guard protects one caller. This protects the
   * engine from every caller.
   */
  it('returns null for an unknown market instead of creating one', async () => {
    const { MatchingEngine } = await import('./engine/engine.js');
    const engine = new MatchingEngine({ journalPath: null, snapshotEvery: 0 } as never);

    expect(engine.depth('NOT-A-MARKET', 50)).toBeNull();
    // The real assertion: the engine did not quietly grow.
    expect(engine.markets).not.toContain('NOT-A-MARKET');
  });

  it('does not grow the engine under repeated probing', async () => {
    const { MatchingEngine } = await import('./engine/engine.js');
    const engine = new MatchingEngine({ journalPath: null, snapshotEvery: 0 } as never);

    for (let i = 0; i < 500; i++) engine.depth(`PHANTOM-${i}`, 50);

    expect(engine.markets).toHaveLength(0);
  });

  /**
   * An opened market with no orders 404'd here, so svc-trade's order preview read it as
   * `trade.no_book` and the desk could never send a first order. It is a live, empty ladder.
   */
  it('serves an opened market with no orders as an empty ladder, without creating a book', async () => {
    const { MatchingEngine } = await import('./engine/engine.js');
    const { MemoryJournal } = await import('./engine/journal.js');
    const engine = new MatchingEngine({ journal: new MemoryJournal(), snapshotEvery: 0 } as never);
    await engine.open('BTC-USDT', { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const app = Fastify({ logger: false });
    registerRoutes(app, engine, 'matching-internal-service-secret-32c', {});
    await app.ready();

    const opened = await app.inject({ method: 'GET', url: '/markets/BTC-USDT/depth?limit=50' });
    const openedL3 = await app.inject({ method: 'GET', url: '/markets/BTC-USDT/depth/l3?limit=50' });
    const unknown = await app.inject({ method: 'GET', url: '/markets/NOT-A-MARKET/depth?limit=50' });
    const unknownL3 = await app.inject({ method: 'GET', url: '/markets/NOT-A-MARKET/depth/l3?limit=50' });

    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ marketId: 'BTC-USDT', bids: [], asks: [], sequence: 0 });
    expect(openedL3.statusCode).toBe(200);
    expect(openedL3.json()).toMatchObject({ level: 'L3', marketId: 'BTC-USDT', bids: [], asks: [] });
    expect(unknown.statusCode).toBe(404);
    expect(unknownL3.statusCode).toBe(404);
    expect(engine.hasMarket('BTC-USDT')).toBe(false);
    await app.close();
  });
});

describe('cancel does not allocate a book', () => {
  /**
   * W7 residual — cancel used book() and invented never-traded markets.
   * Depth was fixed earlier; the HTTP cancel door must show the same honesty.
   */
  it('returns 404 for an unknown market without creating one', async () => {
    const { MatchingEngine } = await import('./engine/engine.js');
    const SECRET = 'matching-internal-service-secret-32c';
    const engine = new MatchingEngine({ journalPath: null, snapshotEvery: 0 } as never);
    const app = Fastify({ logger: false });
    registerRoutes(app, engine, SECRET, {});
    await app.ready();

    const ghost = 'NEVER-TRADED-VIA-HTTP';
    const res = await app.inject({
      method: 'DELETE',
      url: `/markets/${ghost}/orders/00000000-0000-4000-8000-deadbeef0001`,
      headers: serviceAuthHeadersForBody('svc-trade', SECRET, ''),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('OrderNotFound');
    expect(res.json().message).toBe(userCopy('matching.order_not_found'));
    expect(engine.hasMarket(ghost)).toBe(false);
    expect(engine.markets).not.toContain(ghost);
    await app.close();
  });
});

// ── The reconciliation surface ───────────────────────────────────────────────
//
// `reconcile.ts` is unit-tested against a real engine in `reconcile.test.ts`.
// What is tested here is the part a function cannot test about itself: that it
// is REACHABLE, that reaching it needs credentials, and that reaching it does
// not cancel anything. A reconciler nobody can call is not a safety net, and a
// reconciler anyone can call is a way to enumerate whose orders rest where.

describe('the reconciliation routes', () => {
  const SECRET = 'matching-internal-service-secret-32c';

  const RESTING = {
    marketId: 'BTC-USDT',
    orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    accountId: 'acct-1',
    kind: 'book' as const,
    side: 'buy' as const,
    price: '100',
    remaining: '2',
    sequence: 1,
  };

  /** Fails loudly if the read routes ever reach for a write. */
  function fakeEngine(over: Record<string, unknown> = {}) {
    return {
      markets: ['BTC-USDT'],
      hasMarket: (m: string) => m === 'BTC-USDT',
      restingOrders: () => [RESTING],
      cancel: () => {
        throw new Error('a read route cancelled an order');
      },
      submit: () => {
        throw new Error('a read route submitted an order');
      },
      ...over,
    };
  }

  async function mount(engine: unknown) {
    const app = Fastify({ logger: false });
    registerRoutes(app, engine as never, SECRET, {});
    await app.ready();
    return app;
  }

  // ── GET /markets/:marketId/orders ──────────────────────────────────────────

  it('refuses an unauthenticated liveness read, and the engine is never asked', async () => {
    let asked = false;
    const app = await mount(fakeEngine({ restingOrders: () => ((asked = true), [RESTING]) }));

    const res = await app.inject({ method: 'GET', url: '/markets/BTC-USDT/orders' });

    // Depth is public because a price is not a secret. A list of whose orders
    // rest where is a different fact, and an order id is all you need to cancel.
    expect(res.statusCode).toBe(401);
    expect(asked).toBe(false);
    await app.close();
  });

  it('returns the resting orders to a signed caller without cancelling them', async () => {
    let calls = 0;
    const app = await mount(fakeEngine({ restingOrders: () => (calls++, [RESTING]) }));

    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, '');
    const first = await app.inject({ method: 'GET', url: '/markets/BTC-USDT/orders?limit=2', headers });
    const second = await app.inject({ method: 'GET', url: '/markets/BTC-USDT/orders?limit=2', headers });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ marketId: 'BTC-USDT', orders: [RESTING] });
    // The whole point of the read: asking twice gives the same answer. `cancel`
    // on this fake throws, so a probe that repaired would have failed the suite.
    expect(second.json()).toEqual(first.json());
    expect(calls).toBe(2);
    await app.close();
  });

  it('refuses an authenticated non-trade liveness read without disclosing orders', async () => {
    let asked = false;
    const app = await mount(fakeEngine({ restingOrders: () => ((asked = true), [RESTING]) }));

    const res = await app.inject({
      method: 'GET',
      url: '/markets/BTC-USDT/orders',
      headers: serviceAuthHeadersForBody('svc-execution', SECRET, ''),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'Forbidden', message: userCopy('error.forbidden') });
    expect(asked).toBe(false);
    await app.close();
  });

  it('separates "no such market" from "a market with nothing resting"', async () => {
    const app = await mount(fakeEngine({ restingOrders: () => [] }));
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, '');

    const unknown = await app.inject({ method: 'GET', url: '/markets/NOT-A-MARKET/orders?limit=2', headers });
    const empty = await app.inject({ method: 'GET', url: '/markets/BTC-USDT/orders?limit=2', headers });

    // A reconciler that cannot tell these apart reports a whole live book as
    // missing — or reports a deleted market as clean.
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('MarketNotFound');
    expect(unknown.json().message).toBe(userCopy('matching.market_not_found'));
    expect(empty.statusCode).toBe(200);
    expect(empty.json().orders).toEqual([]);
    await app.close();
  });

  // ── POST /reconcile ────────────────────────────────────────────────────────

  it('refuses an unauthenticated reconcile', async () => {
    const app = await mount(fakeEngine());

    const res = await app.inject({
      method: 'POST',
      url: '/reconcile',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ orders: [] }),
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('reports the stranded-hold case as a 200 refusal naming both sides', async () => {
    const app = await mount(fakeEngine({ restingOrders: () => [] }));

    const body = JSON.stringify({
      orders: [
        {
          orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          marketId: 'BTC-USDT',
          state: 'open',
          remaining: '2',
          funded: true,
          detail: 'hold=200 USDT',
        },
      ],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/reconcile',
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, body) },
      payload: body,
    });

    // 200, not 4xx: a refusal is a correct answer to the question asked. A
    // caller polling this must not have to tell "engine unreachable" apart from
    // "engine found stranded money".
    expect(res.statusCode).toBe(200);

    const report = res.json();
    expect(report.ok).toBe(false);
    expect(report.refusals).toBe(1);
    expect(report.findings[0].case).toBe('counterpart_open_engine_missing');
    expect(report.findings[0].engine).toContain('NOT LIVE');
    expect(report.findings[0].counterpart).toContain('hold=200 USDT');
    await app.close();
  });

  it('refuses an authenticated non-trade reconcile before parsing or engine access', async () => {
    let asked = false;
    const app = await mount(fakeEngine({ restingOrders: () => ((asked = true), [RESTING]) }));
    const body = JSON.stringify({ orders: [] });

    const res = await app.inject({
      method: 'POST',
      url: '/reconcile',
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-execution', SECRET, body) },
      payload: body,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'Forbidden', message: userCopy('error.forbidden') });
    expect(asked).toBe(false);
    await app.close();
  });

  it('rejects a malformed counterpart view instead of reconciling against it', async () => {
    const app = await mount(fakeEngine());

    // `funded` missing. Nothing in this file may guess it: `funded: false` is
    // the one verdict that authorises deleting a row without asking.
    const body = JSON.stringify({
      orders: [{ orderId: 'x', marketId: 'BTC-USDT', state: 'open', remaining: '1' }],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/reconcile',
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, body) },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().issues)).toContain('funded');
    await app.close();
  });

  it('moves nothing — a clean run and a refusing run both leave the engine untouched', async () => {
    // `cancel` and `submit` on the fake throw. If reconciliation ever grows a
    // repair, this is the test that fails first.
    const app = await mount(fakeEngine());

    const body = JSON.stringify({
      orders: [{ orderId: RESTING.orderId, marketId: 'BTC-USDT', state: 'open', remaining: '2', funded: true }],
    });
    const clean = await app.inject({
      method: 'POST',
      url: '/reconcile',
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, body) },
      payload: body,
    });

    expect(clean.json()).toMatchObject({ ok: true, agreed: 1, refusals: 0 });

    // And the engine still has it — the read did not consume the order.
    const empty = JSON.stringify({ orders: [] });
    const orphaned = await app.inject({
      method: 'POST',
      url: '/reconcile',
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, empty) },
      payload: empty,
    });

    expect(orphaned.json()).toMatchObject({ ok: false, refusals: 1 });
    expect(orphaned.json().findings[0].case).toBe('engine_only');
    await app.close();
  });
});
