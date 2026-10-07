import { describe, expect, it } from 'vitest';
import { MemoryVenueVaultStore, VenueVault, VenueVaultNotFoundError } from './vault.js';
import { WithdrawalPermissionRefusedError } from './permissions.js';
import { parseKek, VenueVaultKekUnconfiguredError, VenueVaultUnwrapFailedError } from './wrap.js';

/** 32-byte test wrap only — never a production KEK. */
const TEST_KEK = parseKek('11'.repeat(32));

describe('S-L6 VenueVault', () => {
  it('refuses withdrawal-capable keys before anything is stored', async () => {
    const store = new MemoryVenueVaultStore();
    const vault = new VenueVault(store, TEST_KEK);
    await expect(
      vault.register('user-a', {
        venueId: 'binance-spot',
        apiKey: 'ak-secret-material',
        apiSecret: 'as-secret-material',
        permissions: { scopes: ['spot', 'withdraw'] },
      }),
    ).rejects.toBeInstanceOf(WithdrawalPermissionRefusedError);
    expect(store.rows.size).toBe(0);
  });

  it('stores ciphertext, never plaintext, and unwraps trade-only for the owner', async () => {
    const store = new MemoryVenueVaultStore();
    const vault = new VenueVault(store, TEST_KEK);
    const { id } = await vault.register('user-a', {
      venueId: 'bybit-spot',
      apiKey: 'ak-secret-material',
      apiSecret: 'as-secret-material',
      permissions: { scopes: ['trade', 'read'] },
    });
    const dumped = JSON.stringify([...store.rows.values()]);
    expect(dumped).not.toContain('ak-secret-material');
    expect(dumped).not.toContain('as-secret-material');

    const opened = await vault.unwrapForTrade('user-a', id);
    expect(opened.apiKey).toBe('ak-secret-material');
    expect(opened.venueId).toBe('bybit-spot');

    await expect(vault.unwrapForTrade('user-b', id)).rejects.toBeInstanceOf(VenueVaultNotFoundError);
  });

  it('does not return another user secret when that ciphertext is swapped onto the caller row', async () => {
    const store = new MemoryVenueVaultStore();
    const vault = new VenueVault(store, TEST_KEK);
    const { id: callerId } = await vault.register('user-caller', {
      venueId: 'bybit-spot',
      apiKey: 'caller-api-key',
      apiSecret: 'caller-api-secret',
      permissions: { scopes: ['trade', 'read'] },
    });
    const { id: otherId } = await vault.register('user-other', {
      venueId: 'okx-spot',
      apiKey: 'other-api-key',
      apiSecret: 'other-api-secret',
      permissions: { scopes: ['trade', 'read'] },
    });
    const callerRow = store.rows.get(callerId);
    const otherRow = store.rows.get(otherId);
    expect(callerRow?.userId).toBe('user-caller');
    expect(otherRow).toBeDefined();
    store.rows.set(callerId, { ...callerRow!, wrapped: otherRow!.wrapped });
    expect(store.rows.get(callerId)?.userId).toBe('user-caller');

    await expect(vault.unwrapForTrade('user-caller', callerId)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(VenueVaultUnwrapFailedError);
      const refused = err instanceof Error ? `${err.name} ${err.message} ${JSON.stringify(err)}` : String(err);
      expect(refused).not.toContain('other-api-secret');
      expect(refused).not.toContain('other-api-key');
      return true;
    });

    const owned = await vault.unwrapForTrade('user-other', otherId);
    expect(owned.apiSecret).toBe('other-api-secret');
  });

  it('fail-closes when the wrap key is missing (HSM residual)', () => {
    expect(() => parseKek('')).toThrow(VenueVaultKekUnconfiguredError);
    expect(() => parseKek('aa')).toThrow(VenueVaultKekUnconfiguredError);
  });
});
