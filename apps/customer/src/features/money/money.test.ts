import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import { createMoneyClient } from './client';

const owner = 'a779d840-9715-4517-af5d-d9f7195e466a';
const wire = (data: unknown) => new Response(JSON.stringify({ result: { data } }));

describe('Money public network boundary', () => {
  it('refuses numeric ledger money instead of showing a known zero balance', async () => {
    const api = createApiClient({
      fetch: async () =>
        wire([
          {
            id: 'available',
            assetId: 'BTC',
            kind: 'primary',
            name: 'Primary',
            balance: 0,
            goalTarget: null,
            lockedUntil: null,
            ledgerAccount: { ownerType: 'user', ownerId: owner, assetId: 'BTC', kind: 'available' },
          },
        ]),
    });
    const result = await createMoneyClient(api).spaces(50);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
});

it('shows one available projection without adding a primary alias or claiming held money is zero', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/spaces.unnamed')) return wire([{ assetId: 'BTC', balance: '0.200000000000000001' }]);
    return wire([
      {
        id: 'label',
        assetId: 'BTC',
        kind: 'primary',
        name: 'Primary',
        balance: '0.200000000000000001',
        goalTarget: null,
        lockedUntil: null,
        ledgerAccount: { ownerType: 'user', ownerId: owner, assetId: 'BTC', kind: 'available' },
      },
    ]);
  };
  const result = await createMoneyClient(createApiClient({ fetch: fetcher })).overview(owner, 50);
  expect(result.holdings).toEqual([{ assetId: 'BTC', available: '0.200000000000000001', held: null, quantity: null }]);
  expect(result.coverage).toBe('partial');
});

it('sends a reviewed transfer as an exact amount and preserves its request identity', async () => {
  let request: { path: string; body: unknown } | undefined;
  const api = createApiClient({
    fetch: async (input, options) => {
      request = { path: String(input), body: JSON.parse(String(options?.body)) };
      return wire({ ledgerTxId: 'settled-original-request', amount: '0.000000000000000001' });
    },
  });
  const from = {
    id: '7880f322-b31d-4de1-a3eb-ebdd38f11709',
    assetId: 'BTC',
    kind: 'primary' as const,
    name: 'Primary',
    balance: '1',
    goalTarget: null,
    lockedUntil: null,
    ledgerAccount: { ownerType: 'user', ownerId: owner, assetId: 'BTC', kind: 'available' },
  };
  const to = { ...from, id: '422cdfae-55ad-43b8-a36c-ac93d6e34715', kind: 'named' as const, name: 'Goal' };
  const result = await createMoneyClient(api).transfer([from, to], {
    transferId: 'f4f21135-782d-4796-b6e8-342ef967e0ea',
    fromSpaceId: from.id,
    toSpaceId: to.id,
    amount: '0.000000000000000001',
  });
  expect(result).toMatchObject({ ok: true, data: { ledgerTxId: 'settled-original-request' } });
  expect(request).toEqual({
    path: '/api/bank/trpc/transfers.create',
    body: { transferId: 'f4f21135-782d-4796-b6e8-342ef967e0ea', fromSpaceId: from.id, toSpaceId: to.id, amount: '0.000000000000000001' },
  });
});

it('uses the owner-scoped balance facade and never adds the same primary-space amount again', async () => {
  const paths: string[] = [];
  const api = createApiClient({
    fetch: async (input) => {
      const path = String(input);
      paths.push(path.split('?')[0]!);
      if (path === '/api/v1/account/balance')
        return new Response(
          JSON.stringify({
            timestamp: 1791374400000,
            datetime: '2026-10-07T12:00:00Z',
            balances: { BTC: { free: '0.2', used: '0.1', total: '0.3' } },
          }),
        );
      if (path.includes('spaces.unnamed')) return wire([]);
      return wire([
        {
          id: 'label',
          assetId: 'BTC',
          kind: 'primary',
          name: 'Primary',
          balance: '0.2',
          goalTarget: null,
          lockedUntil: null,
          ledgerAccount: { ownerType: 'user', ownerId: owner, assetId: 'BTC', kind: 'available' },
        },
      ]);
    },
  });
  const view = await createMoneyClient(api).overview(owner, 50);
  expect(view.holdings).toEqual([{ assetId: 'BTC', available: '0.2', held: '0.1', quantity: '0.3' }]);
  expect(paths).toContain('/api/v1/account/balance');
  expect(paths.some((path) => path.startsWith('/api/ledger'))).toBe(false);
});

it('refuses a malformed source lock rather than treating it as unlocked', async () => {
  const api = createApiClient({
    fetch: async () =>
      wire([
        {
          id: 'label',
          assetId: 'BTC',
          kind: 'primary',
          name: 'Primary',
          balance: '1',
          goalTarget: null,
          lockedUntil: 'unknown-lock-date',
          ledgerAccount: { ownerType: 'user', ownerId: owner, assetId: 'BTC', kind: 'available' },
        },
      ]),
  });
  expect(await createMoneyClient(api).spaces(50)).toMatchObject({ ok: false, reason: 'invalid_response' });
});
