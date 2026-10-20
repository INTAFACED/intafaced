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

  it('publishes an empty catalogue as empty, and an unreachable pay as not published', async () => {
    const empty = createPayCustodyDepositPort({
      catalogue: async () => ({ state: 'ok', catalogue: { entries: [] } }),
      address: async () => UNAVAILABLE,
    });
    expect(await empty.listAssets()).toEqual([]);
    const down = createPayCustodyDepositPort({ catalogue: async () => UNAVAILABLE, address: async () => UNAVAILABLE });
    expect(await down.listAssets()).toBeNull();
  });

  it('returns an issued address, and null for a refusal or an unreachable pay, never an invented address', async () => {
    const issued = createPayCustodyDepositPort({
      catalogue: async () => UNAVAILABLE,
      address: async () => ({ state: 'issued', address: { address: '0xabc', memo: null, qrPayload: null } }),
    });
    expect(await issued.address(input)).toEqual({ address: '0xabc', memo: null, qrPayload: null });
    for (const reply of [
      { state: 'refused', code: 'pay.deposit_pair_unpublished' } as const,
      { state: 'refused', code: 'pay.deposit_source_unset' } as const,
      UNAVAILABLE,
    ]) {
      const port = createPayCustodyDepositPort({ catalogue: async () => UNAVAILABLE, address: async () => reply });
      expect(await port.address(input)).toBeNull();
    }
  });

  it('reports no incoming deposits as not connected until the deposit record exists', async () => {
    const port = createPayCustodyDepositPort({ catalogue: async () => UNAVAILABLE, address: async () => UNAVAILABLE });
    expect(await port.pending('user-1')).toBeNull();
  });
});
