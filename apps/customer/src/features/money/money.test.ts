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

describe('a note and a payment reference travel with a transfer', () => {
  const space = (id: string, kind: 'primary' | 'named') => ({
    id,
    assetId: 'USDT',
    kind,
    name: kind === 'primary' ? 'Primary' : 'Goal',
    balance: '50',
    goalTarget: null,
    lockedUntil: null,
    ledgerAccount: { ownerType: 'user', ownerId: owner, assetId: 'USDT', kind: 'available' },
  });
  const from = space('7880f322-b31d-4de1-a3eb-ebdd38f11709', 'primary');
  const to = space('422cdfae-55ad-43b8-a36c-ac93d6e34715', 'named');
  const transferId = 'f4f21135-782d-4796-b6e8-342ef967e0ea';
  const person = 'b3f2f3a2-4a59-4d3e-9f0b-2f4c9c3b1a77';
  const capture = (reply: unknown) => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const api = createApiClient({
      fetch: async (input, options) => {
        requests.push({ path: String(input), body: JSON.parse(String(options?.body)) });
        return wire(reply);
      },
    });
    return { api, requests };
  };

  it('sends both to a person, trimmed, and accepts the reply that echoes them', async () => {
    const { api, requests } = capture({
      ledgerTxId: 'tx-1',
      amount: '5',
      note: 'Rent for October',
      reference: 'INV-2026-10',
      requestId: null,
    });
    const result = await createMoneyClient(api).transfer([from, to], {
      transferId,
      fromSpaceId: from.id,
      toUserId: person,
      amount: '5',
      note: '  Rent for October ',
      reference: ' INV-2026-10 ',
    });
    expect(result).toMatchObject({ ok: true, data: { ledgerTxId: 'tx-1' } });
    expect(requests).toEqual([
      {
        path: '/api/bank/trpc/transfers.toUser',
        body: { transferId, fromSpaceId: from.id, toUserId: person, amount: '5', note: 'Rent for October', reference: 'INV-2026-10' },
      },
    ]);
  });
  it('leaves a blank note or reference out of the request altogether', async () => {
    const { api, requests } = capture({ ledgerTxId: 'tx-1', amount: '5', note: null, reference: null });
    await createMoneyClient(api).transfer([from, to], {
      transferId,
      fromSpaceId: from.id,
      toUserId: person,
      amount: '5',
      note: '   ',
      reference: '',
    });
    expect(Object.keys(requests[0]!.body).sort()).toEqual(['amount', 'fromSpaceId', 'toUserId', 'transferId']);
  });
  it('sends them between the customer’s own accounts too', async () => {
    const { api, requests } = capture({ ledgerTxId: 'tx-2', amount: '5' });
    const result = await createMoneyClient(api).transfer([from, to], {
      transferId,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '5',
      note: 'Holiday',
      reference: 'GOAL-1',
    });
    expect(result.ok).toBe(true);
    expect(requests[0]).toMatchObject({ path: '/api/bank/trpc/transfers.create', body: { note: 'Holiday', reference: 'GOAL-1' } });
  });
  it('refuses a reply whose stored note or reference differs from the one reviewed', async () => {
    for (const reply of [
      { ledgerTxId: 'tx-1', amount: '5', note: 'Something else', reference: 'INV-1' },
      { ledgerTxId: 'tx-1', amount: '5', note: 'Rent', reference: null },
      { ledgerTxId: 'tx-1', amount: '5' },
    ]) {
      const { api } = capture(reply);
      const result = await createMoneyClient(api).transfer([from, to], {
        transferId,
        fromSpaceId: from.id,
        toUserId: person,
        amount: '5',
        note: 'Rent',
        reference: 'INV-1',
      });
      expect(result).toMatchObject({ ok: false, reason: 'uncertain' });
    }
  });
  it('refuses a bad note or reference before anything is sent, in words', async () => {
    const { api, requests } = capture({});
    const client = createMoneyClient(api);
    const base = { transferId, fromSpaceId: from.id, toUserId: person, amount: '5' };
    const long = await client.transfer([from, to], { ...base, note: 'x'.repeat(141) });
    expect(long).toMatchObject({ ok: false, code: 'money.invalid_transfer', message: 'Keep the note to 140 characters or fewer.' });
    // Counted in UTF-16 units, as the bank counts them: 71 emoji are 142 units, one more than the limit allows.
    const emoji = await client.transfer([from, to], { ...base, note: '😀'.repeat(71) });
    expect(emoji).toMatchObject({ ok: false, message: 'Keep the note to 140 characters or fewer.' });
    expect((await client.transfer([from, to], { ...base, note: 'x\u007Fy' })).ok).toBe(false);
    const control = await client.transfer([from, to], { ...base, note: 'two\nlines' });
    expect(control).toMatchObject({ ok: false, message: 'A note is plain text. Remove line breaks and other control characters.' });
    const accent = await client.transfer([from, to], { ...base, reference: 'Café' });
    expect(accent).toMatchObject({ ok: false, message: expect.stringContaining('Remove accents and emoji') });
    const tooLong = await client.transfer([from, to], { ...base, reference: 'R'.repeat(65) });
    expect(tooLong).toMatchObject({ ok: false, message: 'Keep the reference to 64 characters or fewer.' });
    expect(requests).toEqual([]);
    expect(
      await client
        .transfer([from, to], { ...base, note: 'x'.repeat(140), reference: 'R'.repeat(64) })
        .then((result) => result.ok || result.code),
    ).not.toBe('money.invalid_transfer');
  });
  it('sends the same request again when the same transfer is resent, so the bank sends it once', async () => {
    const { api, requests } = capture({ ledgerTxId: 'tx-1', amount: '5', note: 'Rent', reference: null });
    const draft = { transferId, fromSpaceId: from.id, toUserId: person, amount: '5', note: 'Rent' };
    await createMoneyClient(api).transfer([from, to], draft);
    await createMoneyClient(api).transfer([from, to], draft);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]!.body.transferId).toBe(transferId);
  });
});
