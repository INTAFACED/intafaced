import { keccak256, toBytes } from 'viem';
import { HDKey, hdKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { readExtendedPublicKey, receivingAddress, uncompressedPublicKey } from './keys.js';

/**
 * The receiving address we give a payer must be the one the business's own wallet derives with its private key, or the
 * money lands where nobody can spend it. Checked against viem's own derivation from the private side (m/44'/60'/0'/0/i,
 * what EVM wallets use), on a TEST seed that is public and holds nothing anywhere.
 */
const master = HDKey.fromMasterSeed(toBytes(keccak256(toBytes('intafaced TEST receiving wallet keys'))));
const account = master.derive("m/44'/60'/0'");

describe('the business’s own receiving addresses, from its public key alone', () => {
  it('derives, from the xpub only, the same addresses the wallet derives from its private key', () => {
    const key = readExtendedPublicKey(account.publicExtendedKey);
    expect(key.privateKey).toBeNull();
    for (const addressIndex of [0, 1, 2, 7, 1000]) {
      expect(receivingAddress(key, addressIndex)).toBe(hdKeyToAccount(master, { addressIndex }).address);
    }
  });

  it('refuses a private key by name, and a key that does not read', () => {
    expect(() => readExtendedPublicKey(account.privateExtendedKey)).toThrow(
      expect.objectContaining({ code: 'pay.receiving_wallet_private_key' }),
    );
    const xpub = account.publicExtendedKey;
    const broken = `${xpub.slice(0, -1)}${xpub.endsWith('a') ? 'b' : 'a'}`;
    expect(() => readExtendedPublicKey(broken)).toThrow(expect.objectContaining({ code: 'pay.receiving_wallet_invalid' }));
    expect(() => readExtendedPublicKey('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toThrow(
      expect.objectContaining({ code: 'pay.receiving_wallet_invalid' }),
    );
  });

  it('refuses an index outside the non-hardened range and a point that is not compressed', () => {
    const key = readExtendedPublicKey(account.publicExtendedKey);
    expect(() => receivingAddress(key, -1)).toThrow();
    expect(() => receivingAddress(key, 2 ** 31)).toThrow();
    expect(() => uncompressedPublicKey(new Uint8Array(65))).toThrow();
  });
});
