import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import { createTradeApi } from './trade-api';
import { LinkedDepth } from './depth';
import { createToolApi } from './tool-api';

const reviewed = {
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  type: 'limit' as const,
  amount: '0.025',
  price: '80000',
  timeInForce: 'GTC' as const,
  holdAsset: 'USDT',
  holdAmount: '2000',
  protectionPrice: null,
  estimatedFee: '0.000025',
  feeAsset: 'BTC',
  feeBps: 10,
  feeRole: 'taker' as const,
  orderable: true,
  refusals: [],
};
const intent = {
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  type: 'limit' as const,
  amount: '0.025',
  price: '80000',
  timeInForce: 'GTC' as const,
  postOnly: false,
  clientOrderId: 'intent-1',
};
const sourceOrder = {
  id: 'original-1',
  clientOrderId: 'original-client',
  timestamp: 1,
  datetime: '2026-10-07T00:00:00Z',
  lastTradeTimestamp: null,
  symbol: 'BTC/USDT',
  type: 'limit',
  side: 'buy',
  timeInForce: 'GTC',
  postOnly: false,
  reduceOnly: false,
  price: '80000',
  stopPrice: null,
  average: null,
  amount: '0.025',
  filled: '0',
  remaining: '0.025',
  cost: '0',
  status: 'open',
  fee: null,
  trades: [],
  recoveryRequired: false,
  recoveryReason: null,
  reconciliationKey: null,
};

describe('order changes read', () => {
  const row = {
    kind: 'amend',
    at: '2026-10-01T00:00:00.000Z',
    quantity: '2',
    price: '55',
    version: '1',
    relatedOrderId: null,
    direction: null,
  };
  const apiFor = (body: unknown) => createTradeApi(createApiClient({ fetch: async () => new Response(JSON.stringify(body)) }));
  it('returns the rows for the order asked about', async () => {
    const result = await apiFor({ orderId: 'original-1', amendments: [row] }).changes('original-1');
    expect(result).toMatchObject({ ok: true, data: [{ kind: 'amend', quantity: '2' }] });
  });
  it('refuses a reply that names another order', async () => {
    const result = await apiFor({ orderId: 'another-order', amendments: [row] }).changes('original-1');
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
});

describe('trading feature network boundary', () => {
  it.each(['read', 'cancel', 'amend'] as const)('refuses another valid order identity returned by %s', async (kind) => {
    const wrongOrder = { ...sourceOrder, id: 'another-order', status: 'canceled' };
    const response =
      kind === 'amend'
        ? {
            accepted: true,
            idempotent: false,
            code: 'AMENDED',
            reasonCode: null,
            reconciliationRequired: false,
            path: 'NATIVE_AMEND',
            priority: 'retained',
            orderId: 'original-1',
            order: wrongOrder,
          }
        : wrongOrder;
    const api = createTradeApi(createApiClient({ fetch: async () => new Response(JSON.stringify(response)) }));
    const result =
      kind === 'read'
        ? await api.order(sourceOrder)
        : kind === 'cancel'
          ? await api.cancel(sourceOrder)
          : await api.amend(sourceOrder, '0.010');
    expect(result).toMatchObject({ ok: false, reason: kind === 'read' ? 'invalid_response' : 'uncertain' });
  });
  it('retains an amendment whose envelope names another order or whose original is still recovering', async () => {
    for (const response of [
      { orderId: 'another-order', order: sourceOrder },
      { orderId: 'original-1', order: { ...sourceOrder, recoveryRequired: true } },
    ]) {
      const api = createTradeApi(
        createApiClient({
          fetch: async () =>
            new Response(
              JSON.stringify({
                accepted: true,
                idempotent: false,
                code: 'AMENDED',
                reasonCode: null,
                reconciliationRequired: false,
                path: 'NATIVE_AMEND',
                priority: 'retained',
                ...response,
              }),
            ),
        }),
      );
      expect(await api.amend(sourceOrder, '0.010')).toMatchObject({ ok: false, reason: 'uncertain' });
    }
  });
  it.each(['read', 'cancel', 'amend'] as const)('retains %s when the matching order ID has another reviewed market', async (kind) => {
    const wrongMarket = { ...sourceOrder, symbol: 'ETH/USDT', status: 'canceled' };
    const response =
      kind !== 'amend'
        ? wrongMarket
        : {
            accepted: true,
            idempotent: false,
            code: 'AMENDED',
            reasonCode: null,
            reconciliationRequired: false,
            path: 'NATIVE_AMEND',
            priority: 'retained',
            orderId: sourceOrder.id,
            order: wrongMarket,
          };
    const api = createTradeApi(createApiClient({ fetch: async () => new Response(JSON.stringify(response)) }));
    expect(
      kind === 'read'
        ? await api.order(sourceOrder)
        : kind === 'cancel'
          ? await api.cancel(sourceOrder)
          : await api.amend(sourceOrder, '0.010'),
    ).toMatchObject({ ok: false, reason: kind === 'read' ? 'invalid_response' : 'uncertain' });
  });
  it.each(['original envelope', 'replacement envelope', 'original market', 'replacement market', 'original still open'] as const)(
    'retains replacement when its %s contradicts the reviewed identities',
    async (kind) => {
      const original = { ...sourceOrder, status: 'canceled' };
      const replacement = { ...sourceOrder, id: 'replacement-1', clientOrderId: intent.clientOrderId };
      const response = {
        accepted: true,
        idempotent: false,
        code: 'REPLACED',
        reasonCode: null,
        reconciliationRequired: false,
        path: 'CANCEL_REPLACE',
        originalOrderId: sourceOrder.id,
        originalState: 'cancelled',
        replacementOrderId: replacement.id,
        replacementState: 'open',
        original,
        replacement,
      };
      if (kind === 'original envelope') response.originalOrderId = 'different-original';
      if (kind === 'replacement envelope') response.replacementOrderId = 'different-replacement';
      if (kind === 'original market') original.symbol = 'ETH/USDT';
      if (kind === 'replacement market') replacement.symbol = 'ETH/USDT';
      if (kind === 'original still open') original.status = 'open';
      const api = createTradeApi(
        createApiClient({ fetch: async (url) => new Response(JSON.stringify(String(url).endsWith('/preview') ? reviewed : response)) }),
      );
      expect(await api.replace(sourceOrder, intent, reviewed)).toMatchObject({ ok: false, reason: 'uncertain' });
    },
  );
  it('refuses contradictory candles instead of presenting malformed prices as history', async () => {
    const api = createTradeApi(createApiClient({ fetch: async () => new Response(JSON.stringify([[1, '100', '99', '101', '100', '1']])) }));
    expect(await api.history('BTC/USDT', '1m')).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
  it('refreshes replacement authority and leaves the original untouched when its reservation changes', async () => {
    const requests: string[] = [];
    const api = createTradeApi(
      createApiClient({
        fetch: async (url) => {
          requests.push(String(url));
          return new Response(JSON.stringify({ ...reviewed, holdAmount: '2001' }));
        },
      }),
    );
    const result = await api.replace(sourceOrder, intent, reviewed);
    expect(result).toMatchObject({ ok: false, reason: 'changed' });
    expect(requests).toEqual(['/api/v1/orders/preview']);
  });
  it('does not dispatch a live placement after the originating account or mode changes during preview', async () => {
    const requests: string[] = [];
    const api = createTradeApi(
      createApiClient({
        fetch: async (url) => {
          requests.push(String(url));
          return new Response(JSON.stringify(reviewed));
        },
      }),
    );
    const result = await api.place(intent, reviewed, () => false);
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
    expect(requests).toEqual(['/api/v1/orders/preview']);
  });
  it('refuses numeric money in order preview instead of offering confirmation', async () => {
    const api = createTradeApi(
      createApiClient({
        fetch: async () =>
          new Response(
            JSON.stringify({
              symbol: 'BTC/USDT',
              side: 'buy',
              type: 'limit',
              amount: 0.025,
              price: '80000',
              timeInForce: 'GTC',
              holdAsset: 'USDT',
              holdAmount: '2000',
              protectionPrice: null,
              estimatedFee: '0.000025',
              feeAsset: 'BTC',
              feeBps: 10,
              feeRole: 'taker',
              orderable: true,
              refusals: [],
            }),
          ),
      }),
    );
    const result = await api.preview({
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '0.025',
      price: '80000',
      timeInForce: 'GTC',
      postOnly: false,
      clientOrderId: 'intent-1',
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
  it('requires review again when authoritative reservation changes and sends no order', async () => {
    const requests: string[] = [];
    const api = createTradeApi(
      createApiClient({
        fetch: async (url) => {
          requests.push(String(url));
          return new Response(JSON.stringify({ ...reviewed, holdAmount: '2001' }));
        },
      }),
    );
    expect(await api.place(intent, reviewed)).toMatchObject({ ok: false, reason: 'changed', preview: { holdAmount: '2001' } });
    expect(requests).toEqual(['/api/v1/orders/preview']);
  });
  it('preserves explicit base quantity and never sends reviewed fee or hold in an order request', async () => {
    const requests: { url: string; body: unknown }[] = [];
    const api = createTradeApi(
      createApiClient({
        fetch: async (url, options) => {
          requests.push({ url: String(url), body: JSON.parse(String(options?.body)) });
          return new Response(JSON.stringify(requests.length === 1 ? reviewed : {}));
        },
      }),
    );
    await api.place(intent, reviewed);
    expect(requests[1]).toEqual({
      url: '/api/v1/orders',
      body: {
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        amount: '0.025',
        price: '80000',
        timeInForce: 'GTC',
        postOnly: false,
        clientOrderId: 'intent-1',
      },
    });
  });
  it('does not accept wrong-market public depth even when the response is a valid book', async () => {
    const api = createTradeApi(
      createApiClient({
        fetch: async () =>
          new Response(
            JSON.stringify({
              symbol: 'ETH/USDT',
              bids: [['100', '1']],
              asks: [['101', '2']],
              timestamp: 1,
              datetime: '2026-10-07T00:00:00Z',
              nonce: 1,
            }),
          ),
      }),
    );
    expect(await api.book('BTC/USDT')).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
  it('refuses malformed history instead of returning an empty chart', async () => {
    const api = createTradeApi(createApiClient({ fetch: async () => new Response(JSON.stringify([[1, '100', '101', '99', 100, '1']])) }));
    expect(await api.history('BTC/USDT', '1m')).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
  it('clears another market and rejects a sequence gap until a matching snapshot arrives', () => {
    const depth = new LinkedDepth('market-a');
    expect(depth.receive({ type: 'snapshot', marketId: 'market-a', sequence: 10, bids: [['100', '1']], asks: [['101', '2']] }, 100)).toBe(
      'accepted',
    );
    expect(depth.receive({ type: 'delta', marketId: 'market-a', fromSequence: 12, sequence: 13, bids: [], asks: [] }, 101)).toBe('gap');
    expect(depth.read(102).fresh).toBe(false);
    expect(depth.receive({ type: 'snapshot', marketId: 'market-b', sequence: 20, bids: [['100', '1']], asks: [] }, 103)).toBe(
      'wrong_market',
    );
    expect(depth.read(104).fresh).toBe(false);
    expect(depth.receive({ type: 'snapshot', marketId: 'market-a', sequence: 13, bids: [['100', '1']], asks: [['101', '2']] }, 105)).toBe(
      'accepted',
    );
    expect(depth.read(106).fresh).toBe(true);
    expect(depth.read(16000).fresh).toBe(false);
  });
  it('keeps a quote in its original asset units and refuses numeric amounts', async () => {
    const transport = createApiClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            result: {
              data: {
                quoteId: 'q1',
                symbol: 'ETH/USDT',
                side: 'buy',
                requestedQty: '1',
                filledQty: '1',
                bookNotional: '100',
                userNotional: '101',
                avgPrice: '101',
                fullyFilled: true,
                convertSpreadBps: 100,
                expiresAt: '2026-10-07T10:00:00Z',
                source: { kind: 'book', symbol: 'ETH/USDT', asOf: '2026-10-07T09:59:00Z' },
                inAsset: 'USDT',
                outAsset: 'ETH',
                inAmount: 101,
                outAmount: '1',
              },
            },
          }),
        ),
    });
    expect(await createToolApi(transport).convertQuote({ symbol: 'ETH/USDT', side: 'buy', qty: '1' })).toMatchObject({
      ok: false,
      reason: 'invalid_response',
    });
  });
});
