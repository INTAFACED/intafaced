import { afterEach, describe, expect, it } from 'vitest';
import type { BankOwnSpacesPort } from '@intafaced/contracts';
import { TAX_DATA_LAKE_UNAVAILABLE, TAX_INDEXER_UNAVAILABLE, TAX_LOT_BOOK_UNRECONCILED, TAX_OWN_SPACES_UNAVAILABLE } from './codes.js';
import { createTaxLedgerReads } from './ledger-reads.js';
import { TaxService } from './tax-service.js';

/**
 * J-portfolio-04 #2 (PF-cost-basis-02, LB-6) through the real ledger reader over a fake svc-ledger. TEST data, hand-computed:
 * buy 1 BTC for 100 USDT on 1 Oct, then move it from the main account to the customer's space "TEST cold" on 5 Oct.
 */
const USER = '11111111-1111-4111-8111-111111111111';
const SPACE = '33333333-3333-4333-8333-333333333333';
const realFetch = globalThis.fetch;

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

function ledger() {
  const asked: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    asked.push({ path, ...body });
    let result: unknown = { entries: [], nextCursor: null };
    const moved = { txId: 'mv', reason: 'bank.transfer.manual', amount: '1', assetId: 'BTC', postedAt: '2026-10-05T00:00:00.000Z' };
    if (path === '/trpc/balances') {
      result = [];
    } else if (body.ownerType === 'user' && body.kind === 'available') {
      result = {
        entries: [
          entry({ ...moved, direction: 'credit' }),
          entry({ txId: 'buy', direction: 'debit', amount: '1', assetId: 'BTC', orderId: 'o1' }),
        ],
        nextCursor: null,
      };
    } else if (body.kind === 'hold' && body.purpose === 'order:o1') {
      result = { entries: [entry({ txId: 'buy', direction: 'credit', amount: '100', assetId: 'USDT' })], nextCursor: null };
    } else if (body.ownerType === 'subaccount' && body.ownerId === SPACE && body.kind === 'available') {
      result = { entries: [entry({ ...moved, direction: 'debit' })], nextCursor: null };
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return asked;
}

const read: BankOwnSpacesPort = {
  list: async () => ({ state: 'read', spaces: [{ spaceId: SPACE, assetId: 'BTC', name: 'TEST cold', archived: false }] }),
};
const service = (spaces?: BankOwnSpacesPort) =>
  new TaxService({
    mapRaw: '',
    reads: createTaxLedgerReads('http://ledger.test', 'test-internal-service-secret-32-chars'),
    lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
    indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
    now: () => new Date('2026-10-11T00:00:00.000Z'),
    ...(spaces ? { spaces } : {}),
  });

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('tax.lotBook own-account carry', () => {
  it('the bought lot keeps its acquired date and basis and is listed in the space, and the main account reconciles', async () => {
    const asked = ledger();
    const book = await service(read).lotBook({ userId: USER });
    expect(book.spaces).toEqual({ status: 'read', list: [{ spaceId: SPACE, assetId: 'BTC', name: 'TEST cold', archived: false }] });
    const inSpace = book.lots.filter((lot) => lot.spaceId === SPACE);
    expect(inSpace).toEqual([
      {
        id: 'lot:buy:BTC>mv',
        assetId: 'BTC',
        acquiredAt: '2026-10-01T00:00:00.000Z',
        source: 'trade',
        qty: '1',
        remaining: '1',
        costUsd: '100',
        remainingCostUsd: '100',
        valuedAt: null,
        daysHeld: 10,
        termClass: null,
        spaceId: SPACE,
        carriedFrom: { lotId: 'lot:buy:BTC', txId: 'mv', movedAt: '2026-10-05T00:00:00.000Z' },
      },
    ]);
    // The main account's lot is used up by the move, not sold: no sale, and nothing left open on main to disagree with.
    expect(book.lots.find((lot) => lot.id === 'lot:buy:BTC')).toMatchObject({ remaining: '0', remainingCostUsd: '0' });
    expect(book.sales).toEqual([]);
    expect(book.residuals).toEqual([]);
    // The space is read by its own scope, which svc-bank named; nothing else is asked about.
    expect(asked.filter((c) => c.ownerType === 'subaccount').map((c) => c.ownerId)).toEqual([SPACE]);
  });

  it('with no answer from the bank the move is not followed, and the book says so instead of guessing', async () => {
    ledger();
    const book = await service({ list: async () => ({ state: 'unavailable', code: 'bank.own_spaces_unavailable' }) }).lotBook({
      userId: USER,
    });
    expect(book.spaces).toEqual({ status: 'unavailable', code: TAX_OWN_SPACES_UNAVAILABLE });
    expect(book.residuals).toEqual(expect.arrayContaining([TAX_OWN_SPACES_UNAVAILABLE, TAX_LOT_BOOK_UNRECONCILED]));
    expect(book.lots.some((lot) => lot.spaceId !== undefined)).toBe(false);
  });

  it('with no bank configured the book follows the main account and names it', async () => {
    ledger();
    const book = await service().lotBook({ userId: USER });
    expect(book.spaces).toEqual({ status: 'unwired', code: 'tax.own_spaces_unwired' });
  });
});
