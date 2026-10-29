import { describe, expect, it } from 'vitest';
import { ANY_NETWORK, fraudAddressKey, fraudListingFields, fraudNetworkKey, memoryFraudList } from './fraud-list.js';

/** W-withdraw-03: how an address and a network are keyed on the fraud list, without a database. */
describe('destination fraud list keys', () => {
  it('keys an EVM address in lower case and any other address exactly as written', () => {
    expect(fraudAddressKey(' 0x7E5700000000000000000000000000000000FA1D ')).toBe('0x7e5700000000000000000000000000000000fa1d');
    expect(fraudAddressKey('bc1QxyZ')).toBe('bc1QxyZ');
  });

  it('takes * or a network id, and refuses anything else', () => {
    expect(fraudNetworkKey(ANY_NETWORK)).toBe('*');
    expect(fraudNetworkKey('Ethereum')).toBe('ethereum');
    expect(() => fraudNetworkKey('eth net')).toThrow(/not a network id/);
  });

  it('binds an approval to the normalised change and the next revision', () => {
    expect(
      fraudListingFields({ network: 'Base', address: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01', listed: true, expectedRevision: 2 }),
    ).toEqual({
      network: 'base',
      address: '0xabcdef0123456789abcdef0123456789abcdef01',
      listed: 'true',
      revision: '3',
    });
  });

  it('an empty list lists nothing; a listing matches its network or every network', async () => {
    expect(await memoryFraudList().isListed('ethereum', '0x7e5700000000000000000000000000000000fa1d')).toBe(false);
    const list = memoryFraudList([
      { network: '*', address: '0x7E5700000000000000000000000000000000FA1D' },
      { network: 'base', address: '0x1111111111111111111111111111111111111111' },
    ]);
    expect(await list.isListed('ethereum', '0x7e5700000000000000000000000000000000fa1d')).toBe(true);
    expect(await list.isListed('base', '0x1111111111111111111111111111111111111111')).toBe(true);
    expect(await list.isListed('ethereum', '0x1111111111111111111111111111111111111111')).toBe(false);
  });
});
