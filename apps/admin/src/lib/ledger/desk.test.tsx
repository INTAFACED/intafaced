import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GET } from '@/app/api/ledger-desk/[read]/route';
import { LedgerDesk, deskRefusal } from '@/components/ledger-desk';
import { TransactionView } from '@/components/ledger-lookup';
import { deskQuery, deskSearch, localToIso, parseDeskAnswer } from './desk';
import type { LedgerTransaction } from './lookup';

const auth = vi.hoisted(() => ({ authorize: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/founder-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/founder-session')>()),
  authorizeAdminRequest: auth.authorize,
}));

const TX = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '55555555-5555-4555-8555-555555555555';
const ctx = {
  session: { userId: '11111111-1111-4111-8111-111111111111', accessToken: 'founder-access-token' },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
// TEST figures only.
const page = {
  total: '51',
  rows: [
    {
      txId: TX,
      seq: '51',
      businessKey: 'deposit:local-test:TEST-1',
      module: 'ledger',
      reason: 'deposit.credited',
      postedAt: '2026-10-24T12:00:00.000Z',
      assets: ['USDT'],
      postings: '2',
    },
  ],
  nextCursor: '51',
};
const accounts = {
  prefix: 'house:fees',
  accounts: [
    {
      accountId: ACCOUNT,
      address: 'house:fees:trade',
      ownerType: 'house',
      ownerId: 'fees:trade',
      assetId: 'USDT',
      kind: 'available',
      purpose: '',
      debits: '3.5',
      credits: '1',
      balance: '2.5',
      postings: '3',
    },
  ],
  nextCursor: null,
};
const stats = {
  transactions: '51',
  postings: '102',
  accounts: '9',
  assets: '2',
  lastSeq: '51',
  lastPostedAt: '2026-10-24T12:00:00.000Z',
  asOf: '2026-10-24T12:01:00.000Z',
};

describe('the desk queries', () => {
  it('drops blank filters, keeps the read’s keys in order, and refuses what svc-ledger would refuse', () => {
    expect(deskQuery('transactions', { assetId: ' USDT ', from: '', to: undefined })).toEqual({ assetId: 'USDT' });
    expect(deskSearch('transactions', { before: '9', assetId: 'USDT' })).toBe('assetId=USDT&before=9');
    expect(deskQuery('transactions', { from: '2026-10-25T00:00:00.000Z', to: '2026-10-24T00:00:00.000Z' })).toBeNull();
    expect(deskQuery('transactions', { from: 'yesterday' })).toBeNull();
    expect(deskQuery('transactions', { before: '0' })).toBeNull();
    expect(deskQuery('transactions', { before: '9223372036854775808' })).toBeNull();
    // A filter time is an instant with its offset, as svc-ledger takes it.
    expect(deskQuery('transactions', { from: '2026-10-24' })).toBeNull();
    expect(deskQuery('transactions', { from: '2026-10-24T12:00:00' })).toBeNull();
    expect(deskQuery('transactions', { from: '2026-10-24T12:00:00+02:00' })).toEqual({ from: '2026-10-24T12:00:00+02:00' });
    expect(deskQuery('transactions', { txId: TX })).toBeNull();
    expect(deskQuery('accounts', { prefix: 'house:fees' })).toEqual({ prefix: 'house:fees' });
    for (const prefix of ['', 'house', 'house:', 'fees:trade', 'admin:x']) expect(deskQuery('accounts', { prefix }), prefix).toBeNull();
    expect(deskQuery('accounts', { prefix: 'house:f', after: 'nope' })).toBeNull();
    expect(deskQuery('stats', {})).toEqual({});
    expect(deskQuery('stats', { all: '1' })).toBeNull();
    expect(localToIso('')).toBe('');
    expect(localToIso('not a time')).toBe('');
    expect(localToIso('2026-10-24T12:00:00Z')).toBe('2026-10-24T12:00:00.000Z');
  });
});

describe('parseDeskAnswer', () => {
  it('reads each answer exactly, counts and amounts kept as strings', () => {
    expect(parseDeskAnswer('transactions', {}, page)).toEqual({ read: 'transactions', page });
    expect(parseDeskAnswer('accounts', { prefix: 'house:fees' }, accounts)).toEqual({ read: 'accounts', page: accounts });
    expect(parseDeskAnswer('stats', {}, stats)).toEqual({ read: 'stats', stats });
    expect(parseDeskAnswer('stats', {}, { ...stats, lastSeq: null, lastPostedAt: null })).not.toBeNull();
  });

  it('refuses a number where the ledger sends a string, a row for another prefix, an address that is not its parts, and a bad cursor', () => {
    expect(parseDeskAnswer('transactions', {}, { ...page, total: 51 })).toBeNull();
    expect(parseDeskAnswer('transactions', {}, { ...page, rows: [{ ...page.rows[0], postings: 2 }] })).toBeNull();
    expect(parseDeskAnswer('transactions', {}, { ...page, nextCursor: 'abc' })).toBeNull();
    // The ledger counts on the first page only: a later page answers null, and a first page without a count is refused.
    expect(parseDeskAnswer('transactions', { before: '60' }, { ...page, total: null })).toMatchObject({ page: { total: null } });
    expect(parseDeskAnswer('transactions', { before: '60' }, page)).toBeNull();
    expect(parseDeskAnswer('transactions', {}, { ...page, total: null })).toBeNull();
    expect(parseDeskAnswer('accounts', { prefix: 'house:other' }, accounts)).toBeNull();
    expect(parseDeskAnswer('accounts', { prefix: 'house:fees' }, { ...accounts, prefix: 'house:other' })).toBeNull();
    expect(
      parseDeskAnswer(
        'accounts',
        { prefix: 'house:fees' },
        { ...accounts, accounts: [{ ...accounts.accounts[0], address: 'house:fees:spot' }] },
      ),
    ).toBeNull();
    expect(
      parseDeskAnswer('accounts', { prefix: 'house:fees' }, { ...accounts, accounts: [{ ...accounts.accounts[0], balance: 2.5 }] }),
    ).toBeNull();
    expect(parseDeskAnswer('stats', {}, { ...stats, accounts: 9 })).toBeNull();
    expect(parseDeskAnswer('stats', {}, null)).toBeNull();
  });
});

let fetchMock: ReturnType<typeof vi.fn>;
const get = (read: string, query = '') =>
  GET(new Request(`https://admin.example/api/ledger-desk/${read}${query ? `?${query}` : ''}`), { params: Promise.resolve({ read }) });

describe('GET /api/ledger-desk/[read]', () => {
  beforeEach(() => {
    auth.authorize.mockResolvedValue(ctx);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    auth.authorize.mockReset();
  });

  it("reads through edge's named route with the founder's own token, and answers what it read", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...page, total: null }));
    const res = await get('transactions', 'assetId=USDT&before=60');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ read: 'transactions', page: { ...page, total: null } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://edge:4000/admin/ledger/transactions?assetId=USDT&before=60');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(init.redirect).toBe('error');

    fetchMock.mockResolvedValue(Response.json(accounts));
    expect(await (await get('accounts', 'prefix=house%3Afees')).json()).toEqual({ read: 'accounts', page: accounts });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://edge:4000/admin/ledger/accounts?prefix=house%3Afees');
    fetchMock.mockResolvedValue(Response.json(stats));
    expect(await (await get('stats')).json()).toEqual({ read: 'stats', stats });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('http://edge:4000/admin/ledger/stats');
  });

  it("keeps the ledger's refusal code, and refuses an answer of the wrong shape", async () => {
    fetchMock.mockResolvedValue(Response.json({ code: 'ledger.lookup_unrecorded', message: 'x' }, { status: 503 }));
    const refused = await get('stats');
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ code: 'ledger.lookup_unrecorded' });
    fetchMock.mockResolvedValue(Response.json({ ...stats, transactions: 51 }));
    const odd = await get('stats');
    expect(odd.status).toBe(502);
    expect(await odd.json()).toEqual({ code: 'admin.upstream_invalid' });
    fetchMock.mockRejectedValue(new Error('down'));
    expect((await get('stats')).status).toBe(503);
  });

  it('refuses an unknown read, a key the read does not take, a repeated key and a bad prefix, sending nothing', async () => {
    expect((await get('dump')).status).toBe(404);
    for (const [read, query] of [
      ['transactions', 'txId=x'],
      ['transactions', 'assetId=USDT&assetId=BTC'],
      ['accounts', 'prefix=fees'],
      ['accounts', ''],
      ['stats', 'all=1'],
    ] as const) {
      const res = await get(read, query);
      expect(res.status, `${read}?${query}`).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'admin.ledger_desk_input' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses without a founder session, sending nothing', async () => {
    const { AdminSessionError } = await import('@/lib/founder-session');
    auth.authorize.mockRejectedValue(new AdminSessionError('admin.session_required', 401));
    expect((await get('stats')).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the desk on the page', () => {
  it('lays out the list, the address search and the counts, with no figure before a read', () => {
    const html = renderToStaticMarkup(<LedgerDesk userId="founder-a" />);
    for (const id of ['ledger-desk-transactions', 'ledger-desk-accounts', 'ledger-desk-stats'])
      expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain('Show transactions');
    expect(html).toContain('Search accounts');
    expect(html).toContain('Count the book');
    expect(html).not.toContain('ledger-desk-total');
    expect(deskRefusal('ledger.lookup_unrecorded', 503)).toContain('could not record this read');
  });

  it('shows a transaction’s place in the log, reference, times, audit entry, and each posting’s side with its before and after', () => {
    const transaction: LedgerTransaction = {
      txId: TX,
      businessKey: 'deposit:local-test:TEST-1',
      module: 'ledger',
      reason: 'deposit.credited',
      postedAt: '2026-10-24T12:00:00.000Z',
      hash: 'h1',
      previousHash: 'h0',
      booking: {
        seq: '51',
        bookedAt: '2026-10-24T12:00:00.010Z',
        reference: 'corr-TEST-1',
        event: { id: 'ev-1', subject: 'intafaced.ledger.tx.posted', recordedAt: '2026-10-24T12:00:00.010Z', publishedAt: null },
      },
      postings: [
        {
          entryId: 'e1',
          accountId: 'a1',
          assetId: 'USDT',
          direction: 'credit',
          side: 'source',
          amount: '25',
          balanceBefore: '0',
          balanceAfter: '-25',
        },
        {
          entryId: 'e2',
          accountId: 'a2',
          assetId: 'USDT',
          direction: 'debit',
          side: 'destination',
          amount: '25',
          balanceBefore: '0',
          balanceAfter: '25',
        },
      ],
    };
    const html = renderToStaticMarkup(<TransactionView transaction={transaction} readAt="2026-10-24T12:01:00.000Z" />);
    expect(html).toContain('data-testid="ledger-lookup-seq">51<');
    expect(html).toContain('corr-TEST-1');
    expect(html).toContain('intafaced.ledger.tx.posted');
    expect(html).toContain('not yet published to the event bus');
    expect(html).toContain('Balance before');
    expect(html).toContain('data-side="source"');
    expect(html).toContain('Destination');
  });
});
