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
};
const entry = (e: Partial<Entry> & Pick<Entry, 'txId' | 'direction' | 'amount' | 'assetId'>): Entry => ({
  reason: 'trade.fill',
  postedAt: '2026-10-01T00:00:00.000Z',
  orderId: null,
  ...e,
});

/** What the fake ledger answers. `available` is served in two pages to prove the reader follows the cursor. */
function ledger(opts: { endless?: boolean } = {}) {
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
                    direction: 'debit',
                    amount: '300',
                    assetId: 'USDT',
                    orderId: 'o2',
                    postedAt: '2026-10-03T00:00:00.000Z',
                  }),
                  entry({ txId: 'noise', reason: 'deposit', direction: 'debit', amount: '500', assetId: 'USDT' }),
                ],
                nextCursor: 'page2',
              }
            : { entries: [entry({ txId: 'buy', direction: 'debit', amount: '1', assetId: 'BTC', orderId: 'o1' })], nextCursor: null };
      } else if (body.kind === 'hold' && body.purpose === 'order:o1') {
        result = { entries: [entry({ txId: 'buy', direction: 'credit', amount: '100', assetId: 'USDT' })], nextCursor: null };
      } else if (body.kind === 'hold' && body.purpose === 'order:o2') {
        result = { entries: [entry({ txId: 'sell', direction: 'credit', amount: '1', assetId: 'BTC' })], nextCursor: null };
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
        assetId: 'BTC',
        txId: 'sell',
        disposedAt: '2026-10-03T00:00:00.000Z',
        qty: '1',
        unmatchedQty: '0',
        proceedsUsd: '300',
        costUsd: '100',
        realizedUsd: '200',
      },
    ]);
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

  it('a different method is honoured and an unknown one is refused by name', async () => {
    ledger();
    const api = createTaxRouter(service()).createCaller(await signed());
    expect((await api.lotBook({ method: 'LIFO' })).method).toBe('LIFO');
    await expect(service().lotBook({ userId: USER, method: 'AVERAGE' })).rejects.toMatchObject({ code: TAX_LOT_METHOD_REQUIRED });
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
});
