import { describe, expect, it, vi } from 'vitest';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { fundJourneyCustomer, journeyDepositWire } from '../../../../tooling/scripts/journey-fund.mjs';

// The journeys' TEST funding (tooling/scripts/journey-fund.mjs). It runs here, with the app's tests, because the journeys
// are its only caller; the journeys themselves need the assembled stack and run only in the Order-path CX-8 workflow.
const userId = '11111111-1111-4111-8111-111111111111';
const secret = 'dev-only-journey-fund-test-secret-xxxxxxxx';
type Entry = { account: unknown; direction: 'debit' | 'credit'; amount: unknown };

function ledger(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));
}

describe('journey TEST funding', () => {
  it('is one balanced deposit with a business key, every amount a decimal string', async () => {
    const wire = (await journeyDepositWire({ userId, assetId: 'USDT', amount: '1234.5' })) as { idempotencyKey: string; entries: Entry[] };
    expect(wire.idempotencyKey).toBe(`deposit:journey-test:journey:USDT:${userId}`);
    expect(wire.entries.length).toBeGreaterThan(0);
    for (const e of wire.entries) expect(e.amount).toBe('1234.5');
    const side = (d: Entry['direction']) => wire.entries.filter((e) => e.direction === d).length;
    expect(side('debit')).toBe(side('credit'));
    expect(() => JSON.stringify(wire)).not.toThrow();
  });

  it('gives the same key on a rerun, so a replay adds nothing', async () => {
    const a = await journeyDepositWire({ userId, assetId: 'USDT', amount: '5' });
    const b = await journeyDepositWire({ userId, assetId: 'USDT', amount: '5' });
    expect(b).toEqual(a);
  });

  it.each(['abc', '1.0000000000000000001', '', '1e3'])('refuses the amount %j before anything reaches the ledger', async (amount) => {
    const fetchImpl = ledger(200, {});
    await expect(
      fundJourneyCustomer({ ledgerUrl: 'http://ledger', internalSecret: secret, userId, assetId: 'USDT', amount, fetchImpl }),
    ).rejects.toThrow(/amount/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the deposit to /trpc/post, signed as svc-trade over the exact body', async () => {
    const fetchImpl = ledger(200, { txId: 'tx-1' });
    await expect(
      fundJourneyCustomer({ ledgerUrl: 'http://ledger', internalSecret: secret, userId, assetId: 'BTC', amount: '0.5', fetchImpl }),
    ).resolves.toEqual({ txId: 'tx-1' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://ledger/trpc/post');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(await journeyDepositWire({ userId, assetId: 'BTC', amount: '0.5' }));
    const headers = init.headers as Record<string, string>;
    expect(verifyServiceHeaders(headers, secret)).toMatchObject({ service: 'svc-trade', rejected: null });
  });

  it('fails the journey when the ledger refuses, naming the status', async () => {
    const fetchImpl = ledger(409, { error: 'conflict' });
    await expect(
      fundJourneyCustomer({ ledgerUrl: 'http://ledger', internalSecret: secret, userId, assetId: 'USDT', amount: '1', fetchImpl }),
    ).rejects.toThrow(/ledger \/trpc\/post 409/);
  });
});
