import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PreparedVenueAction } from '@intafaced/venue-contracts';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';

/** OWNER 288 change 1b: the door's own orders are found for a venue account whatever the letter case of its address. */
const AT = new Date('2026-11-10T00:00:01.000Z');
const USER = '11111111-1111-4111-8111-1111111111c1';
const OWNER = '0x00000000000000000000000000000000000000aB';
const prepared = (venueClientOrderId: string, builderFee: boolean): PreparedVenueAction => ({
  venueId: 'test-venue-sim',
  account: { venueId: 'test-venue-sim', owner: OWNER, subAccount: null },
  signer: { role: 'owner', address: OWNER },
  intent: {
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: parseAmount('0.1'),
    price: parseAmount('60000'),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${USER}:${venueClientOrderId}`,
    builderFee: builderFee ? { builder: OWNER, feeBps: parseAmount('1') } : null,
  },
  nonce: venueClientOrderId,
  venueClientOrderId,
  typedData: {},
  digest: `0xdigest${venueClientOrderId}`,
  builderFee: builderFee ? { builder: OWNER, feeBps: parseAmount('1') } : null,
  preparedAt: new Date('2026-11-10T00:00:00.000Z'),
});

describe('InMemoryPreparedActionStore.sentBuilderFeeOrders', () => {
  it('names signed orders with our fee for the account in any letter case, and nothing else', async () => {
    const store = new InMemoryPreparedActionStore();
    for (const [id, fee, sign] of [
      ['0x01', true, true],
      ['0x02', true, false],
      ['0x03', false, true],
    ] as const) {
      await store.insertOnce(USER, `order:${USER}:${id}`, prepared(id, fee), AT);
      if (sign) await store.signOnce(USER, `order:${USER}:${id}`, { digest: `0xdigest${id}`, signature: '0xsig', signedBy: OWNER }, AT);
    }
    const ids = ['0x01', '0x02', '0x03', '0x04'];
    for (const owner of [OWNER, OWNER.toLowerCase(), OWNER.toUpperCase().replace('0X', '0x')]) {
      expect([...(await store.sentBuilderFeeOrders('test-venue-sim', { owner, subAccount: null }, ids))]).toEqual(['0x01']);
    }
    expect([...(await store.sentBuilderFeeOrders('test-venue-sim', { owner: '0xb2', subAccount: null }, ids))]).toEqual([]);
    expect([...(await store.sentBuilderFeeOrders('test-venue-sim', { owner: OWNER, subAccount: '0xc3' }, ids))]).toEqual([]);
  });
});
