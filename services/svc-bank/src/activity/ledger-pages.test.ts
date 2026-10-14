import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLedgerHistoryPages } from '../ledger-client.js';

const OWNER = '11111111-1111-4111-8111-111111111111';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(respond: () => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return respond();
    }),
  );
  return calls;
}

describe('createLedgerHistoryPages (svc-ledger /trpc/historyPage)', () => {
  it('sends only the strict fields, signed as svc-bank, and parses the page', async () => {
    const calls = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            entries: [
              {
                txId: 't1',
                module: 'ledger',
                reason: 'deposit.credited',
                direction: 'debit',
                amount: '10.50',
                postedAt: '2026-10-13T00:00:00.000Z',
                assetId: 'USDT',
              },
            ],
            nextCursor: 'abc',
          }),
          { status: 200 },
        ),
    );
    const out = await createLedgerHistoryPages('http://ledger.test/', 'secret-secret-secret-secret-secret').page({
      ownerType: 'user',
      ownerId: OWNER,
      kind: 'available',
      limit: 5,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://ledger.test/trpc/historyPage');
    expect(Object.keys(calls[0]!.body).sort()).toEqual(['kind', 'limit', 'ownerId', 'ownerType']);
    expect(Object.keys(calls[0]!.headers).length).toBeGreaterThan(1); // content-type plus the service credential
    expect(out.nextCursor).toBe('abc');
    expect(out.entries[0]).toMatchObject({ txId: 't1', amount: '10.5', assetId: 'USDT', direction: 'debit' });
    expect(out.entries[0]!.postedAt).toEqual(new Date('2026-10-13T00:00:00.000Z'));
  });

  it('passes entryId and rail through when the ledger sends them, and drops a malformed entryId', async () => {
    const e = {
      txId: 't',
      module: 'ledger',
      reason: 'deposit.credited',
      direction: 'debit',
      amount: '1',
      postedAt: '2026-10-13T00:00:00.000Z',
      assetId: 'USDT',
    };
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            entries: [{ ...e, entryId: '42', rail: 'local-test' }, { ...e, entryId: 'nope', rail: null }, e],
            nextCursor: null,
          }),
          { status: 200 },
        ),
    );
    const out = await createLedgerHistoryPages('http://ledger.test', 'secret-secret-secret-secret-secret').page({
      ownerType: 'user',
      ownerId: OWNER,
      kind: 'available',
      limit: 5,
    });
    expect(out.entries[0]).toMatchObject({ entryId: '42', rail: 'local-test' });
    expect(out.entries[1]).not.toHaveProperty('entryId');
    expect(out.entries[1]).toMatchObject({ rail: null });
    expect(out.entries[2]).not.toHaveProperty('entryId');
    expect(out.entries[2]).not.toHaveProperty('rail');
  });

  it('passes orderId through when the ledger names one, and drops null, absent and empty', async () => {
    const e = {
      txId: 't',
      module: 'trade',
      reason: 'trade.fill',
      direction: 'debit',
      amount: '1',
      postedAt: '2026-10-13T00:00:00.000Z',
      assetId: 'BTC',
    };
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ entries: [{ ...e, orderId: 'order-1' }, { ...e, orderId: null }, { ...e, orderId: '' }, e], nextCursor: null }),
          { status: 200 },
        ),
    );
    const out = await createLedgerHistoryPages('http://ledger.test', 'secret-secret-secret-secret-secret').page({
      ownerType: 'user',
      ownerId: OWNER,
      kind: 'available',
      limit: 5,
    });
    expect(out.entries[0]).toMatchObject({ orderId: 'order-1' });
    for (const i of [1, 2, 3]) expect(out.entries[i]).not.toHaveProperty('orderId');
  });

  it('passes assetId and cursor through when given, and nothing else', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 }));
    await createLedgerHistoryPages('http://ledger.test', 'secret-secret-secret-secret-secret').page({
      ownerType: 'subaccount',
      ownerId: OWNER,
      kind: 'available',
      assetId: 'BTC',
      limit: 200,
      cursor: 'v2cursor',
    });
    expect(Object.keys(calls[0]!.body).sort()).toEqual(['assetId', 'cursor', 'kind', 'limit', 'ownerId', 'ownerType']);
  });

  it('throws on a ledger failure, never an empty page', async () => {
    stubFetch(() => new Response('nope', { status: 503 }));
    await expect(
      createLedgerHistoryPages('http://ledger.test', 'secret-secret-secret-secret-secret').page({
        ownerType: 'user',
        ownerId: OWNER,
        kind: 'available',
        limit: 5,
      }),
    ).rejects.toBeDefined();
  });
});
