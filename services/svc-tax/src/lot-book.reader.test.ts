import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  TAX_DATA_LAKE_UNAVAILABLE,
  TAX_INDEXER_UNAVAILABLE,
  TAX_LEDGER_UNWIRED,
  TAX_LOT_BOOK_INCOMPLETE,
  TAX_LOT_METHOD_REQUIRED,
} from './codes.js';
import { createTaxLedgerReads } from './ledger-reads.js';
import { createTaxRouter } from './router.js';
import { TaxService } from './tax-service.js';

/**
 * `tax.lotBook` through the real router and the real ledger reader, over a fake svc-ledger `historyPage` and `balances`.
 * Every figure is hand-computed TEST data. Two fills: buy 1 BTC for 100 USDT, then sell 1 BTC for 300 USDT.
 */
const SECRET = 'a-tax-lot-book-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-tax' });
const realFetch = globalThis.fetch;

function signed(scopes: string[] = ['tax:read']) {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-lot-book',
  });
}

type Entry = {
  txId: string;
  reason: string;
  direction: 'debit' | 'credit';
  amount: string;
  postedAt: string;
  assetId: string;
  orderId: string | null;
  fee?: string | null;
};
const entry = (e: Partial<Entry> & Pick<Entry, 'txId' | 'direction' | 'amount' | 'assetId'>): Entry => ({
  reason: 'trade.fill',
  postedAt: '2026-10-01T00:00:00.000Z',
  orderId: null,
  ...e,
});

/** What the fake ledger answers. `available` is served in two pages to prove the reader follows the cursor. */
function ledger(opts: { endless?: boolean; coinDeposit?: boolean; sellReason?: string } = {}) {
  const asked: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    asked.push({ path, ...body });
    let result: unknown = [];
    if (path === '/trpc/balances') {
      result = [{ accountId: 'a1', assetId: 'USDT', kind: 'available', purpose: '', amount: '300' }];
    } else if (path === '/trpc/historyPage') {
      if (opts.endless) {
        result = { entries: [], nextCursor: 'next' };
      } else if (body.kind === 'available') {
        result =
          body.cursor === undefined
            ? {
                entries: [
                  entry({
                    txId: 'sell',
                    ...(opts.sellReason ? { reason: opts.sellReason } : {}),
                    direction: 'debit',
                    amount: '300',
                    assetId: 'USDT',
                    orderId: 'o2',
                    postedAt: '2026-10-03T00:00:00.000Z',
                    // The ledger names the fee this sale's receiving line paid; the buy's line (below) carries none.
                    fee: '1.5',
                  }),
                  entry({ txId: 'noise', reason: 'deposit', direction: 'debit', amount: '500', assetId: 'USDT' }),
                  entry({ txId: 'released', reason: 'order.hold.released', direction: 'debit', amount: '2', assetId: 'SOL' }),
                  ...(opts.coinDeposit
                    ? [entry({ txId: 'dep', reason: 'deposit.credited', direction: 'debit', amount: '2', assetId: 'BTC' })]
                    : []),
                ],
                nextCursor: 'page2',
              }
            : { entries: [entry({ txId: 'buy', direction: 'debit', amount: '1', assetId: 'BTC', orderId: 'o1' })], nextCursor: null };
      } else if (body.kind === 'hold' && body.purpose === 'order:o1') {
        result = { entries: [entry({ txId: 'buy', direction: 'credit', amount: '100', assetId: 'USDT' })], nextCursor: null };
      } else if (body.kind === 'hold' && body.purpose === 'order:o2') {
        result = {
          entries: [
            entry({
              txId: 'sell',
              ...(opts.sellReason ? { reason: opts.sellReason } : {}),
              direction: 'credit',
              amount: '1',
              assetId: 'BTC',
            }),
          ],
          nextCursor: null,
        };
      } else {
        result = { entries: [], nextCursor: null };
      }
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return asked;
}

const service = (reads = createTaxLedgerReads('http://ledger.test', 'test-internal-service-secret-32-chars')) =>
  new TaxService({
    mapRaw: '',
    reads,
    lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
    indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
  });

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('tax.lotBook', () => {
  it('joins each fill to its paying leg across pages and realises 200 on buy 100, sell 300', async () => {
    const asked = ledger();
    const book = await createTaxRouter(service())
      .createCaller(await signed())
      .lotBook();

    expect(book.method).toBe('FIFO');
    expect(book.indicator).toBe('indicator_not_tax_advice');
    expect(book.realizedUsd).toBe('200');
    expect(book.sales).toEqual([
      {
        kind: 'sale',
        counted: 'all',
        // The fee was taken from the 300 received: it is already inside the result, and shown on its own.
        fee: { status: 'known', assetId: 'USDT', amount: '1.5', usd: '1.5' },
        // Where it was sold: the coin sold over the coin received.
        market: 'BTC/USDT',
        method: 'FIFO',
        methodSource: 'default',
        pickedLotId: null,
        assetId: 'BTC',
        txId: 'sell',
        disposedAt: '2026-10-03T00:00:00.000Z',
        qty: '1',
        unmatchedQty: '0',
        proceedsUsd: '300',
        costUsd: '100',
        realizedUsd: '200',
        matches: [{ lotId: 'lot:buy:BTC', qty: '1', costUsd: '100', proceedsUsd: '300', realizedUsd: '200', counted: true }],
      },
    ]);
    // A ledger line with no fee field leaves that fill's fee unknown, so the total is unknown too, never a guess.
    expect(book.lots.find((lot) => lot.id === 'lot:buy:BTC')?.fee).toEqual({ status: 'unknown' });
    expect(book.feesUsd).toBeNull();
    expect(book.includeTransfers).toBe(true);
    expect(book.residuals).toEqual([]);
    // Self-only: every read is scoped to the caller, never to input.
    for (const call of asked.filter((c) => c.path === '/trpc/historyPage' || c.path === '/trpc/balances')) {
      expect(call.ownerId).toBe(USER);
      expect(call.ownerType).toBe('user');
    }
    // Two available pages (cursor followed) and one hold read per order.
    expect(asked.filter((c) => c.path === '/trpc/historyPage' && c.kind === 'available')).toHaveLength(2);
    expect(
      asked
        .filter((c) => c.kind === 'hold')
        .map((c) => c.purpose)
        .sort(),
    ).toEqual(['order:o1', 'order:o2']);
  });

  it('a sale to the token buyback (trade.fill.buyback) is a sale like any other fill', async () => {
    ledger({ sellReason: 'trade.fill.buyback' });
    const book = await createTaxRouter(service())
      .createCaller(await signed())
      .lotBook();
    expect(book.realizedUsd).toBe('200');
    expect(book.sales).toHaveLength(1);
    expect(book.sales[0]).toMatchObject({
      kind: 'sale',
      assetId: 'BTC',
      txId: 'sell',
      qty: '1',
      unmatchedQty: '0',
      proceedsUsd: '300',
      costUsd: '100',
      realizedUsd: '200',
    });
    expect(book.residuals).toEqual([]);
  });

  it('a different method is honoured and an unknown one is refused by name', async () => {
    ledger();
    const api = createTaxRouter(service()).createCaller(await signed());
    expect((await api.lotBook({ method: 'LIFO' })).method).toBe('LIFO');
    expect((await api.lotBook({ method: 'AVERAGE' })).method).toBe('AVERAGE');
    await expect(service().lotBook({ userId: USER, method: 'LOFO' })).rejects.toMatchObject({ code: TAX_LOT_METHOD_REQUIRED });
  });

  it('names a read that hit the page ceiling instead of showing a short book', async () => {
    ledger({ endless: true });
    const book = await createTaxRouter(service())
      .createCaller(await signed())
      .lotBook();
    expect(book.residuals).toContain(TAX_LOT_BOOK_INCOMPLETE);
  });

  it('refuses with tax.ledger_unwired when the fill reader is not attached', async () => {
    const reads = { balances: async () => [], history: async () => [] };
    await expect(service(reads).lotBook({ userId: USER })).rejects.toMatchObject({ code: TAX_LEDGER_UNWIRED });
  });

  it('a caller without tax:read is refused', async () => {
    ledger();
    await expect(
      createTaxRouter(service())
        .createCaller(await signed(['bank:read']))
        .lotBook(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reads fills against a house quote (trade.fill.mm_maker) like any other fill', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      let result: unknown = [];
      if (path === '/trpc/balances') result = [{ accountId: 'a2', assetId: 'BTC', kind: 'available', purpose: '', amount: '1' }];
      else if (body.kind === 'available')
        result = {
          entries: [entry({ txId: 'cv', reason: 'trade.fill.mm_maker', direction: 'debit', amount: '1', assetId: 'BTC', orderId: 'o9' })],
          nextCursor: null,
        };
      else if (body.kind === 'hold')
        result = {
          entries: [entry({ txId: 'cv', reason: 'trade.fill.mm_maker', direction: 'credit', amount: '250', assetId: 'USDT' })],
          nextCursor: null,
        };
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const book = await createTaxRouter(service())
      .createCaller(await signed())
      .lotBook();
    expect(book.assets.find((a) => a.assetId === 'BTC')).toMatchObject({ openQty: '1', openCostUsd: '250', held: '1' });
  });

  it('a self-trade joins each received leg to its own order, not to the other order in the same transaction', async () => {
    // One transaction moves two of this user\'s orders: o1 receives 1 BTC for 100 USDT, o2 receives 100 USDT for 1 BTC.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      let result: unknown = [];
      if (path === '/trpc/balances') result = [{ accountId: 'a3', assetId: 'BTC', kind: 'available', purpose: '', amount: '1' }];
      else if (body.kind === 'available')
        result = {
          entries: [
            entry({ txId: 'self', direction: 'debit', amount: '1', assetId: 'BTC', orderId: 'o1' }),
            entry({ txId: 'self', direction: 'debit', amount: '100', assetId: 'USDT', orderId: 'o2' }),
          ],
          nextCursor: null,
        };
      else if (body.kind === 'hold' && body.purpose === 'order:o1')
        result = { entries: [entry({ txId: 'self', direction: 'credit', amount: '100', assetId: 'USDT' })], nextCursor: null };
      else if (body.kind === 'hold' && body.purpose === 'order:o2')
        result = { entries: [entry({ txId: 'self', direction: 'credit', amount: '1', assetId: 'BTC' })], nextCursor: null };
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const reads = createTaxLedgerReads('http://ledger.test', 'test-internal-service-secret-32-chars');
    const { fills } = await reads.tradeFills!(USER);
    const byOrder = new Map(fills.map((f) => [f.received.assetId, f.paid?.assetId]));
    expect(byOrder.get('BTC')).toBe('USDT');
    expect(byOrder.get('USDT')).toBe('BTC');
  });

  it("reads each withdrawal from its own hold account, found in the customer's account list, and pairs its lines there", async () => {
    const asked: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      asked.push({ path, ...body });
      let result: unknown = { entries: [], nextCursor: null };
      if (path === '/trpc/balances')
        result = [
          { accountId: 'a4', assetId: 'BTC', kind: 'available', purpose: '', amount: '0' },
          // Two withdrawals of the same coin and amount; the ledger lists their hold accounts even when empty.
          { accountId: 'a5', assetId: 'BTC', kind: 'hold', purpose: 'withdraw:w-ok', amount: '0' },
          { accountId: 'a6', assetId: 'BTC', kind: 'hold', purpose: 'withdraw:w-failed', amount: '0' },
          { accountId: 'a7', assetId: 'BTC', kind: 'hold', purpose: 'order:o7', amount: '0' },
        ];
      else if (body.purpose === 'withdraw:w-ok')
        result = {
          entries: [
            entry({ txId: 'ok-s', reason: 'withdraw.settled', direction: 'credit', amount: '1', assetId: 'BTC' }),
            entry({
              txId: 'ok',
              reason: 'withdraw.held',
              direction: 'debit',
              amount: '1',
              assetId: 'BTC',
              postedAt: '2026-10-05T00:00:00.000Z',
            }),
          ],
          nextCursor: null,
        };
      else if (body.purpose === 'withdraw:w-failed')
        result = {
          entries: [
            entry({ txId: 'bad-r', reason: 'withdraw.reversed', direction: 'credit', amount: '1', assetId: 'BTC' }),
            entry({
              txId: 'bad',
              reason: 'withdraw.held',
              direction: 'debit',
              amount: '1',
              assetId: 'BTC',
              postedAt: '2026-10-04T00:00:00.000Z',
            }),
          ],
          nextCursor: null,
        };
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const reads = createTaxLedgerReads('http://ledger.test', 'test-internal-service-secret-32-chars');
    const { withdrawalHolds } = await reads.tradeFills!(USER);
    expect(withdrawalHolds?.map((h) => [h.purpose, h.lines.map((l) => l.reason)])).toEqual([
      ['withdraw:w-ok', ['withdraw.settled', 'withdraw.held']],
      ['withdraw:w-failed', ['withdraw.reversed', 'withdraw.held']],
    ]);
    // Only withdrawal holds are walked this way, each by its own purpose and for the caller alone.
    const walked = asked.filter((c) => c.kind === 'hold').map((c) => [c.ownerId, c.purpose]);
    expect(walked).toEqual([
      [USER, 'withdraw:w-ok'],
      [USER, 'withdraw:w-failed'],
    ]);
  });

  it("a coin deposit makes that coin's sales unknown, while a released hold and a dollar deposit do not", async () => {
    ledger();
    const clean = await createTaxRouter(service())
      .createCaller(await signed())
      .lotBook();
    expect(clean.realizedUsd).toBe('200');
    ledger({ coinDeposit: true });
    const dirty = await createTaxRouter(service())
      .createCaller(await signed())
      .lotBook();
    expect(dirty.realizedUsd).toBeNull();
    expect(dirty.residuals).toContain('tax.lot_book_unreconciled');
  });
});
