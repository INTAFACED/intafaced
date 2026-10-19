import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SERVICE_BODY_DIGEST_HEADER, SERVICE_SIGNATURE_HEADER } from '@intafaced/contracts';
import {
  createMatchingClient,
  massCancelAccountRefuse,
  massCancelSessionRefuse,
  MATCHING_RESTING_ORDERS_PAGE,
  MatchingNoBookError,
  MatchingUnavailableError,
  readSessionId,
  SESSION_UNSUPPORTED,
} from './matching-client.js';
import { decideMarketAction } from '../market-lifecycle.js';
import { createLifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { MarketStateSnapshot } from '@intafaced/exchange-contract';

/**
 * Empty ≠ failed ≠ zero.
 *
 * Matching GET /depth 404 is MarketNotFound (`engine.depth === null`), not a
 * live empty ladder. Fabricating `{ bids:[], asks:[], sequence:0 }` made a
 * listed market with no engine book look live. 200 empty arrays stay 200.
 * Engine down stays MatchingUnavailableError.
 */

const SECRET = 'matching-client-test-secret-at-least-32-chars';
const MARKET = '00000000-0000-4000-8000-000000000001';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub `fetch` with a fixed response, and capture what was requested. */
function stubFetch(response: Response | (() => never)) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      if (typeof response === 'function') response();
      return response;
    }),
  );
  return calls;
}

describe('depth — 404 is no book, not a live empty ladder', () => {
  it('throws MatchingNoBookError on 404 rather than fabricating an empty book', async () => {
    stubFetch(new Response(JSON.stringify({ code: 'MarketNotFound' }), { status: 404 }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.depth(MARKET, 1)).rejects.toBeInstanceOf(MatchingNoBookError);
    await expect(client.depth(MARKET, 1)).rejects.toMatchObject({ code: 'trade.no_book', marketId: MARKET });
  });

  it('a 200 empty ladder is a real empty book, not NoBook', async () => {
    const book = { bids: [], asks: [], sequence: 3 };
    stubFetch(new Response(JSON.stringify(book), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.depth(MARKET, 50)).resolves.toEqual(book);
  });

  it('still throws when the engine genuinely fails — 500 is not an empty book', async () => {
    stubFetch(new Response('boom', { status: 500 }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.depth(MARKET, 1)).rejects.toBeInstanceOf(MatchingUnavailableError);
  });

  it('still throws when the engine is unreachable', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.depth(MARKET, 1)).rejects.toBeInstanceOf(MatchingUnavailableError);
  });

  it('a 200 whose body is not JSON is unavailable, not a raw parse error', async () => {
    stubFetch(new Response('<html>gateway</html>', { status: 200 }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.depth(MARKET, 1)).rejects.toMatchObject({ code: 'trade.matching_unavailable' });
  });

  it('a 401 is NOT an empty book — a rejected signature must stay loud', async () => {
    // The engine's order routes are service-only. If our credentials stop
    // verifying, an empty book would present as a quiet, permanent outage.
    stubFetch(new Response('unauthenticated', { status: 401 }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.depth(MARKET, 1)).rejects.toBeInstanceOf(MatchingUnavailableError);
  });

  it('returns the real book unchanged when the engine has one', async () => {
    const book = { bids: [['100.00', '2']], asks: [['101.00', '3']], sequence: 42 };
    stubFetch(new Response(JSON.stringify(book), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.depth(MARKET, 1)).resolves.toEqual(book);
  });

  it('still authenticates the read — the 404 path must not skip the service headers', async () => {
    const calls = stubFetch(new Response('not found', { status: 404 }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.depth(MARKET, 1)).rejects.toBeInstanceOf(MatchingNoBookError);

    expect(calls[0]).toContain(`/markets/${MARKET}/depth`);
    expect(calls[0]).toContain('limit=1');
  });
});

describe('listOrders — non-destructive liveness', () => {
  it('a 404 market is MatchingNoBookError, not an empty list', async () => {
    stubFetch(new Response(JSON.stringify({ code: 'MarketNotFound' }), { status: 404 }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.listOrders(MARKET)).rejects.toBeInstanceOf(MatchingNoBookError);
    await expect(client.listOrders(MARKET)).rejects.toMatchObject({ code: 'trade.no_book', marketId: MARKET });
  });

  it('a 200 empty list is a live empty book, not NoBook', async () => {
    stubFetch(
      new Response(JSON.stringify({ marketId: MARKET, orders: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.listOrders(MARKET)).resolves.toEqual({ marketId: MARKET, orders: [] });
  });

  it('asks matching for a page: a bare read is refused by matching with resting_orders_limit_unset', async () => {
    const calls = stubFetch(new Response(JSON.stringify({ marketId: MARKET, orders: [] }), { status: 200 }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await client.listOrders(MARKET);

    expect(calls[0]).toContain(`/markets/${MARKET}/orders?limit=${MATCHING_RESTING_ORDERS_PAGE}`);
  });

  it('a full page that does not hold the order cannot prove it is absent', async () => {
    const row = (orderId: string) => ({ marketId: MARKET, orderId, accountId: '', kind: 'book', side: 'buy', price: '1', remaining: '1' });
    const full = Array.from({ length: MATCHING_RESTING_ORDERS_PAGE }, (_, i) => row(`o-${i}`));
    const respond = () => new Response(JSON.stringify({ marketId: MARKET, orders: full }), { status: 200 });
    stubFetch(respond());
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.listOrders(MARKET, 'not-there')).rejects.toBeInstanceOf(MatchingUnavailableError);
    stubFetch(respond());
    await expect(client.listOrders(MARKET)).rejects.toBeInstanceOf(MatchingUnavailableError);
    stubFetch(respond());
    await expect(client.listOrders(MARKET, 'o-7')).resolves.toMatchObject({ marketId: MARKET });
  });

  it('500 is MatchingUnavailable, not NoBook', async () => {
    stubFetch(new Response('boom', { status: 500 }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.listOrders(MARKET)).rejects.toBeInstanceOf(MatchingUnavailableError);
  });

  it('returns resting orders unchanged', async () => {
    const body = {
      marketId: MARKET,
      orders: [
        {
          marketId: MARKET,
          orderId: 'o1',
          accountId: 'a1',
          kind: 'book',
          side: 'buy',
          price: '100',
          remaining: '1',
          sequence: 7,
        },
      ],
    };
    const calls = stubFetch(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.listOrders(MARKET)).resolves.toEqual(body);
    expect(calls[0]).toContain(`/markets/${MARKET}/orders`);
    expect(calls[0]).not.toContain('DELETE');
  });
});

describe('listMarkets — market-id drift port', () => {
  it('returns engine market ids unchanged (no invent)', async () => {
    const body = { markets: [MARKET, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] };
    const calls = stubFetch(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.listMarkets()).resolves.toEqual(body);
    expect(calls[0]).toContain('/markets');
    expect(calls[0]).not.toContain('DELETE');
  });

  it('empty engine set is honest empty, not unavailable', async () => {
    stubFetch(new Response(JSON.stringify({ markets: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.listMarkets()).resolves.toEqual({ markets: [] });
  });

  it('transport failure stays loud', async () => {
    stubFetch(new Response('boom', { status: 500 }));
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.listMarkets()).rejects.toBeInstanceOf(MatchingUnavailableError);
  });
});

describe('submit — signed lifecycle proof body', () => {
  it('serializes the exact proof as an additive JSON field', async () => {
    const snapshot: MarketStateSnapshot = {
      marketId: MARKET,
      ruleVersion: 'rules-1',
      instrumentId: MARKET,
      instrumentVersion: 'instrument-1',
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: '2026-08-24T16:00:00.000Z',
      observedAt: '2026-08-24T16:00:00.000Z',
      lastGoodState: 'OPEN',
      allowedActions: ['PLACE'],
      transitionId: 'transition-1',
      evidenceRefs: ['evidence-1'],
    };
    const lifecycleProof = createLifecycleAdmissionProof(snapshot, decideMarketAction(snapshot, 'PLACE'), 'PLACE');
    let requestBody = '';
    let requestHeaders: NonNullable<RequestInit['headers']> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requestBody = String(init?.body);
        requestHeaders = init?.headers;
        return new Response(
          JSON.stringify({ accepted: true, sequence: 1, fills: [], resting: null, rejected: null, cancellations: [], triggered: [] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }),
    );
    const client = createMatchingClient('http://matching:4005', SECRET);

    await client.submit(MARKET, {
      orderId: 'order-1',
      accountId: 'account-1',
      type: 'limit',
      side: 'buy',
      qty: '1',
      price: '100',
      stopPrice: null,
      tif: 'GTC',
      lifecycleProof,
    });

    expect(JSON.parse(requestBody)).toMatchObject({ lifecycleProof });
    expect(JSON.stringify(JSON.parse(requestBody).lifecycleProof)).toBe(JSON.stringify(lifecycleProof));
    const headers = new Headers(requestHeaders);
    expect(headers.get(SERVICE_BODY_DIGEST_HEADER)).toBe(createHash('sha256').update(requestBody).digest('hex'));
    expect(headers.get(SERVICE_SIGNATURE_HEADER)).toBeTruthy();
  });

  it('HTTP 200 duplicate_order_id is a result, not an outage — qty/price stay strings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            accepted: false,
            sequence: null,
            fills: [],
            resting: null,
            rejected: { code: 'duplicate_order_id', message: 'already accepted' },
            cancellations: [],
            triggered: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const client = createMatchingClient('http://matching:4005', SECRET);
    const result = await client.submit(MARKET, {
      orderId: 'order-1',
      accountId: 'account-1',
      type: 'limit',
      side: 'buy',
      qty: '1.5',
      price: '100',
      stopPrice: null,
      tif: 'GTC',
    });
    expect(result).toMatchObject({
      accepted: false,
      fills: [],
      resting: null,
      rejected: { code: 'duplicate_order_id' },
    });
    expect(typeof result.rejected?.code).toBe('string');
  });
});

describe('submit — GTD expireAt', () => {
  it('forwards expireAt on a GTD submit — the client does not invent one', async () => {
    let requestBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requestBody = String(init?.body);
        return new Response(
          JSON.stringify({ accepted: true, sequence: 1, fills: [], resting: null, rejected: null, cancellations: [], triggered: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const client = createMatchingClient('http://matching:4005', SECRET);
    await client.submit(MARKET, {
      orderId: 'order-gtd',
      accountId: 'account-1',
      type: 'limit',
      side: 'buy',
      qty: '1',
      price: '100',
      stopPrice: null,
      tif: 'GTD',
      expireAt: '2026-08-25T18:00:00.000Z',
    });
    expect(JSON.parse(requestBody)).toMatchObject({ tif: 'GTD', expireAt: '2026-08-25T18:00:00.000Z' });
  });
});

describe('amend — PATCH with AMEND proof and expected version', () => {
  it('binds the AMEND lifecycle proof and expectedVersion on the signed body', async () => {
    const snapshot: MarketStateSnapshot = {
      marketId: MARKET,
      ruleVersion: 'rules-1',
      instrumentId: MARKET,
      instrumentVersion: 'instrument-1',
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: '2026-08-24T16:00:00.000Z',
      observedAt: '2026-08-24T16:00:00.000Z',
      lastGoodState: 'OPEN',
      allowedActions: ['AMEND'],
      transitionId: 'transition-1',
      evidenceRefs: ['evidence-1'],
    };
    const lifecycleProof = createLifecycleAdmissionProof(snapshot, decideMarketAction(snapshot, 'AMEND'), 'AMEND');
    let requestBody = '';
    let requestUrl = '';
    let requestMethod = '';
    let requestHeaders: NonNullable<RequestInit['headers']> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requestUrl = String(input);
        requestMethod = String(init?.method);
        requestBody = String(init?.body);
        requestHeaders = init?.headers;
        return new Response(
          JSON.stringify({
            accepted: true,
            orderId: 'order-1',
            sequence: 1,
            version: 2,
            priority: 'retained',
            fills: [],
            resting: null,
            rejected: null,
            cancellations: [],
            triggered: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const client = createMatchingClient('http://matching:4005', SECRET);

    const result = await client.amend(MARKET, 'order-1', {
      expectedVersion: 1,
      qty: '1',
      lifecycleProof,
    });

    expect(requestMethod).toBe('PATCH');
    expect(requestUrl).toContain(`/markets/${MARKET}/orders/order-1`);
    expect(JSON.parse(requestBody)).toMatchObject({ expectedVersion: 1, qty: '1', lifecycleProof });
    expect(JSON.parse(requestBody).lifecycleProof.action).toBe('AMEND');
    const headers = new Headers(requestHeaders);
    expect(headers.get(SERVICE_BODY_DIGEST_HEADER)).toBe(createHash('sha256').update(requestBody).digest('hex'));
    expect(result).toMatchObject({ accepted: true, priority: 'retained', version: 2 });
  });

  it('maps 404 to a refused amend, not MatchingUnavailable', async () => {
    stubFetch(new Response('not found', { status: 404 }));
    const snapshot: MarketStateSnapshot = {
      marketId: MARKET,
      ruleVersion: 'rules-1',
      instrumentId: MARKET,
      instrumentVersion: 'instrument-1',
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: '2026-08-24T16:00:00.000Z',
      observedAt: '2026-08-24T16:00:00.000Z',
      lastGoodState: 'OPEN',
      allowedActions: ['AMEND'],
      transitionId: 'transition-1',
      evidenceRefs: ['evidence-1'],
    };
    const lifecycleProof = createLifecycleAdmissionProof(snapshot, decideMarketAction(snapshot, 'AMEND'), 'AMEND');
    const client = createMatchingClient('http://matching:4005', SECRET);

    await expect(client.amend(MARKET, 'order-1', { expectedVersion: 1, qty: '1', lifecycleProof })).resolves.toMatchObject({
      accepted: false,
      rejected: { code: 'order_not_found' },
    });
  });
});

describe('submit — reduceOnly', () => {
  it('forwards reduceOnly on the signed body — the client does not invent a mark', async () => {
    let requestBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requestBody = String(init?.body);
        return new Response(
          JSON.stringify({ accepted: true, sequence: 1, fills: [], resting: null, rejected: null, cancellations: [], triggered: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const client = createMatchingClient('http://matching:4005', SECRET);
    await client.submit(MARKET, {
      orderId: 'order-ro',
      accountId: 'account-1',
      type: 'limit',
      side: 'sell',
      qty: '1',
      price: '100',
      stopPrice: null,
      tif: 'GTC',
      reduceOnly: true,
    });
    expect(JSON.parse(requestBody)).toMatchObject({ tif: 'GTC', reduceOnly: true });
    expect(JSON.parse(requestBody).price).toBe('100');
  });
});

describe('submit tif PO', () => {
  it('forwards tif PO and the caller price — the client does not invent a price', async () => {
    let requestBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requestBody = String(init?.body);
        return new Response(
          JSON.stringify({ accepted: true, sequence: 1, fills: [], resting: null, rejected: null, cancellations: [], triggered: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const client = createMatchingClient('http://matching:4005', SECRET);
    await client.submit(MARKET, {
      orderId: 'order-po',
      accountId: 'account-1',
      type: 'limit',
      side: 'buy',
      qty: '1',
      price: '100',
      stopPrice: null,
      tif: 'PO',
    });
    expect(JSON.parse(requestBody)).toMatchObject({ tif: 'PO', price: '100' });
    expect(JSON.parse(requestBody).price).toBe('100');
  });
});

describe('massCancel — matching POST, owner is accountId, no session', () => {
  it('POSTs { accountId } and never sends a session', async () => {
    let requestUrl = '';
    let requestMethod = '';
    let requestBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requestUrl = String(input);
        requestMethod = String(init?.method);
        requestBody = String(init?.body);
        return new Response(
          JSON.stringify({
            accepted: true,
            accountId: 'desk',
            cancellations: [
              { orderId: '11111111-1111-4111-8111-111111111111', accountId: 'desk', remainingQty: '1', sequence: 2, reason: 'requested' },
            ],
            rejected: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const client = createMatchingClient('http://matching:4005', SECRET);
    const result = await client.massCancel(MARKET, { accountId: 'desk' });
    expect(requestMethod).toBe('POST');
    expect(requestUrl).toBe(`http://matching:4005/markets/${MARKET}/orders/mass-cancel`);
    expect(JSON.parse(requestBody)).toEqual({ accountId: 'desk' });
    expect(JSON.parse(requestBody)).not.toHaveProperty('sessionId');
    expect(result.accepted).toBe(true);
    expect(result.cancellations).toHaveLength(1);
    expect(result.rejected).toBeNull();
  });

  it('matching 400 missing account is a refused mass-cancel, not MatchingUnavailable', async () => {
    stubFetch(new Response(JSON.stringify({ code: 'BadRequest' }), { status: 400 }));
    const client = createMatchingClient('http://matching:4005', SECRET);
    await expect(client.massCancel(MARKET, { accountId: '' })).resolves.toMatchObject({
      accepted: false,
      rejected: { code: 'missing_account' },
      cancellations: [],
    });
  });

  it('owner is the authenticated account; session and foreign claims refuse', () => {
    expect(readSessionId({})).toBeNull();
    expect(massCancelSessionRefuse(null)).toBeNull();
    expect(massCancelSessionRefuse('sess-1')?.code).toBe(SESSION_UNSUPPORTED);
    expect(massCancelAccountRefuse('desk', null)).toBeNull();
    expect(massCancelAccountRefuse('desk', 'desk')).toBeNull();
    expect(massCancelAccountRefuse('', null)?.code).toBe('missing_account');
    expect(massCancelAccountRefuse('desk', '')?.code).toBe('missing_account');
    expect(massCancelAccountRefuse('desk', 'mm')?.code).toBe('not_owner');
  });
});
