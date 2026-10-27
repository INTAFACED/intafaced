import type { PayCustodyDepositPort } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { createPayCustodyDepositPort } from './pay-custody-port.js';

const entry = (assetId: string, networkId: string) => ({
  assetId,
  networkId,
  label: networkId,
  minimumDeposit: '10',
  confirmationsRequired: 12,
  estimatedArrivalMinutes: 5,
  memoRequired: false,
  sharedAddressGroup: null,
});
const UNAVAILABLE = { state: 'unavailable', code: 'pay.custody_deposit_unavailable' } as const;
const input = { userId: 'user-1', assetId: 'USDT', networkId: 'ethereum' };

describe('pay custody deposit port', () => {
  it('groups the catalogue by asset and keeps every network, minimum and confirmation count as pay sent them', async () => {
    const pay: PayCustodyDepositPort = {
      catalogue: async () => ({
        state: 'ok',
        catalogue: { entries: [entry('USDT', 'ethereum'), entry('BTC', 'bitcoin'), entry('USDT', 'tron')] },
      }),
      address: async () => UNAVAILABLE,
      records: async () => UNAVAILABLE,
    };
    expect(await createPayCustodyDepositPort(pay).listAssets()).toEqual([
      {
        assetId: 'USDT',
        networks: [
          { id: 'ethereum', label: 'ethereum', minimumDeposit: '10', confirmationsRequired: 12, estimatedArrivalMinutes: 5 },
          { id: 'tron', label: 'tron', minimumDeposit: '10', confirmationsRequired: 12, estimatedArrivalMinutes: 5 },
        ],
      },
      {
        assetId: 'BTC',
        networks: [{ id: 'bitcoin', label: 'bitcoin', minimumDeposit: '10', confirmationsRequired: 12, estimatedArrivalMinutes: 5 }],
      },
    ]);
  });

  it('carries the owner’s unsupported-case list on its network, and adds none where pay published none', async () => {
    const cases = ['TEST: a send from a smart contract'];
    const port = createPayCustodyDepositPort({
      catalogue: async () => ({
        state: 'ok',
        catalogue: { entries: [{ ...entry('USDT', 'ethereum'), unsupported: cases }, entry('USDT', 'tron')] },
      }),
      address: async () => UNAVAILABLE,
      records: async () => UNAVAILABLE,
    });
    const [usdt] = (await port.listAssets())!;
    expect(usdt!.networks[0]!.unsupported).toEqual(cases);
    expect(usdt!.networks[1]).not.toHaveProperty('unsupported');
  });

  it('carries the pairs the owner switched off, with their notes, beside the open ones', async () => {
    const port = createPayCustodyDepositPort({
      catalogue: async () => ({
        state: 'ok',
        catalogue: {
          entries: [entry('USDC', 'base')],
          halted: [
            { assetId: 'USDT', networkId: 'base', label: 'TEST Base', haltNote: 'TEST maintenance' },
            { assetId: 'USDC', networkId: 'ethereum', label: 'TEST Ethereum', haltNote: null },
          ],
        },
      }),
      address: async () => UNAVAILABLE,
      records: async () => UNAVAILABLE,
    });
    expect(await port.catalogue!()).toEqual({
      assets: [
        {
          assetId: 'USDC',
          networks: [{ id: 'base', label: 'base', minimumDeposit: '10', confirmationsRequired: 12, estimatedArrivalMinutes: 5 }],
        },
      ],
      halted: [
        { assetId: 'USDT', networkId: 'base', label: 'TEST Base', haltNote: 'TEST maintenance' },
        { assetId: 'USDC', networkId: 'ethereum', label: 'TEST Ethereum', haltNote: null },
      ],
    });
    // An older pay reply without the list names none as switched off.
    const older = createPayCustodyDepositPort({
      catalogue: async () => ({ state: 'ok', catalogue: { entries: [] } }),
      address: async () => UNAVAILABLE,
      records: async () => UNAVAILABLE,
    });
    expect(await older.catalogue!()).toEqual({ assets: [], halted: [] });
  });

  it('publishes an empty catalogue as empty, and an unreachable pay as not published', async () => {
    const empty = createPayCustodyDepositPort({
      catalogue: async () => ({ state: 'ok', catalogue: { entries: [] } }),
      address: async () => UNAVAILABLE,
      records: async () => UNAVAILABLE,
    });
    expect(await empty.listAssets()).toEqual([]);
    const down = createPayCustodyDepositPort({
      catalogue: async () => UNAVAILABLE,
      address: async () => UNAVAILABLE,
      records: async () => UNAVAILABLE,
    });
    expect(await down.listAssets()).toBeNull();
    expect(await down.catalogue!()).toBeNull();
  });

  it('returns an issued address, and null for a refusal or an unreachable pay, never an invented address', async () => {
    const issued = createPayCustodyDepositPort({
      catalogue: async () => UNAVAILABLE,
      address: async () => ({ state: 'issued', address: { address: '0xabc', memo: null, qrPayload: null } }),
      records: async () => UNAVAILABLE,
    });
    expect(await issued.address(input)).toEqual({ address: '0xabc', memo: null, qrPayload: null, expiresAt: null });
    for (const reply of [
      { state: 'refused', code: 'pay.deposit_pair_unpublished' } as const,
      { state: 'refused', code: 'pay.deposit_source_unset' } as const,
      UNAVAILABLE,
    ]) {
      const port = createPayCustodyDepositPort({
        catalogue: async () => UNAVAILABLE,
        address: async () => reply,
        records: async () => UNAVAILABLE,
      });
      expect(await port.address(input)).toBeNull();
    }
  });

  it('passes an extra address through with its stored expiry, and repeats no answer for another number or without an expiry', async () => {
    const expiresAt = '2026-11-23T12:00:00.000Z';
    const extra = { ...input, addressIndex: 2, expiresAt };
    const answering = (address: object) =>
      createPayCustodyDepositPort({
        catalogue: async () => UNAVAILABLE,
        address: async () => ({ state: 'issued', address: { address: '0xdef', memo: null, qrPayload: null, ...address } }),
        records: async () => UNAVAILABLE,
      });
    expect(await answering({ addressIndex: 2, expiresAt }).address(extra)).toEqual({
      address: '0xdef',
      memo: null,
      qrPayload: null,
      expiresAt,
    });
    expect(await answering({ addressIndex: 1, expiresAt }).address(extra)).toBeNull();
    expect(await answering({}).address(extra)).toBeNull();
    expect(await answering({ addressIndex: 2, expiresAt: null }).address(extra)).toBeNull();
    // The first address never carries a number from an extra one.
    expect(await answering({ addressIndex: 2, expiresAt }).address(input)).toBeNull();
  });

  const record = (over: object = {}) => ({
    id: 'dep-1',
    assetId: 'USDT',
    networkId: 'ethereum',
    address: '0xabc',
    txHash: '0xdead',
    outputIndex: 0,
    amount: '25',
    confirmations: 3,
    confirmationsRequired: 12,
    status: 'confirming' as const,
    reason: null,
    minimumDeposit: '10',
    detectedAt: '2026-10-20T10:00:00.000Z',
    creditedAt: null,
    ...over,
  });
  const withRecords = (records: PayCustodyDepositPort['records']) =>
    createPayCustodyDepositPort({ catalogue: async () => UNAVAILABLE, address: async () => UNAVAILABLE, records });

  it('reports incoming deposits from the pay record, asking only for the open states and one past the door cap', async () => {
    const asked: unknown[] = [];
    const port = withRecords(async (query) => {
      asked.push(query);
      return { state: 'ok', records: { items: [record(), record({ id: 'dep-2', confirmationsRequired: null })], total: 2 } };
    });
    expect(await port.pending('user-1')).toEqual([
      { id: 'dep-1', assetId: 'USDT', networkId: 'ethereum', amount: '25', confirmations: 3, confirmationsRequired: 12 },
      { id: 'dep-2', assetId: 'USDT', networkId: 'ethereum', amount: '25', confirmations: 3, confirmationsRequired: null },
    ]);
    expect(asked).toEqual([{ userId: 'user-1', statuses: ['detected', 'confirming'], offset: 0, limit: 101 }]);
  });

  it('keeps an empty pending list empty, and an unreachable pay not published', async () => {
    expect(await withRecords(async () => ({ state: 'ok', records: { items: [], total: 0 } })).pending('u')).toEqual([]);
    expect(await withRecords(async () => UNAVAILABLE).pending('u')).toBeNull();
    expect(await withRecords(async () => UNAVAILABLE).records?.({ userId: 'u', offset: 0, limit: 5 })).toBeNull();
  });

  it('passes the history filters through and returns the page with its total', async () => {
    const port = withRecords(async (query) => {
      expect(query).toMatchObject({ userId: 'u', assetId: 'USDT', statuses: ['credited'], txHash: '0xdead', offset: 5, limit: 10 });
      return { state: 'ok', records: { items: [record({ status: 'credited' })], total: 6 } };
    });
    const page = await port.records?.({ userId: 'u', assetId: 'USDT', statuses: ['credited'], txHash: '0xdead', offset: 5, limit: 10 });
    expect(page?.total).toBe(6);
    expect(page?.items).toHaveLength(1);
  });
});
