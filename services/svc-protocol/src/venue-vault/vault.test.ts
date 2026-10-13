import { describe, expect, it } from 'vitest';
import { createCipheriv } from 'node:crypto';
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

  it('binds same-user ciphertext to the original record and venue', async () => {
    const store = new MemoryVenueVaultStore();
    const vault = new VenueVault(store, TEST_KEK);
    const make = (venueId: string, apiSecret: string) =>
      vault.register('user-a', {
        venueId,
        apiSecret,
        apiKey: 'test-key',
        permissions: { scopes: ['trade'] },
      });
    const { id: first } = await make('venue-a', 'first-secret');
    const { id: second } = await make('venue-b', 'second-secret');
    const original = store.rows.get(first)!;
    const donor = store.rows.get(second)!;
    store.rows.set(first, { ...original, wrapped: donor.wrapped });
    await expect(vault.unwrapForTrade('user-a', first)).rejects.toBeInstanceOf(VenueVaultUnwrapFailedError);
    store.rows.set(first, { ...original, venueId: 'venue-b' });
    await expect(vault.unwrapForTrade('user-a', first)).rejects.toBeInstanceOf(VenueVaultUnwrapFailedError);
    store.rows.set(first, donor);
    await expect(vault.unwrapForTrade('user-a', first)).rejects.toBeInstanceOf(VenueVaultNotFoundError);
    store.rows.set(first, original);
    await expect(vault.unwrapForTrade('user-a', first)).resolves.toMatchObject({ venueId: 'venue-a', apiSecret: 'first-secret' });
    await expect(vault.unwrapForTrade('user-a', second)).resolves.toMatchObject({ venueId: 'venue-b', apiSecret: 'second-secret' });
  });

  it('refuses invalid authentication tag and IV lengths with the typed error', async () => {
    const store = new MemoryVenueVaultStore();
    const vault = new VenueVault(store, TEST_KEK);
    const { id } = await vault.register('user-a', {
      venueId: 'venue-a',
      apiSecret: 'test-secret',
      apiKey: 'test-key',
      permissions: { scopes: ['trade'] },
    });
    const original = store.rows.get(id)!;
    for (const wrapped of [
      { ...original.wrapped, tag: Buffer.alloc(15) },
      { ...original.wrapped, iv: Buffer.alloc(0) },
      { ...original.wrapped, ciphertext: Buffer.from('poisoned') },
    ]) {
      store.rows.set(id, { ...original, wrapped });
      await expect(vault.unwrapForTrade('user-a', id)).rejects.toBeInstanceOf(VenueVaultUnwrapFailedError);
    }
  });

  it('refuses an unbound legacy blob and a changed KEK without mutating the stored row', async () => {
    const store = new MemoryVenueVaultStore();
    const vault = new VenueVault(store, TEST_KEK);
    const credential = { venueId: 'venue-a', apiSecret: 'original-secret', apiKey: 'test-key', permissions: { scopes: ['trade'] } };
    const { id } = await vault.register('user-a', credential);
    const original = store.rows.get(id)!;
    const wrongKekVault = new VenueVault(store, parseKek('22'.repeat(32)));
    await expect(wrongKekVault.unwrapForTrade('user-a', id)).rejects.toBeInstanceOf(VenueVaultUnwrapFailedError);
    expect(store.rows.get(id)).toBe(original);
    await expect(vault.unwrapForTrade('user-a', id)).resolves.toMatchObject(credential);

    const iv = Buffer.alloc(12, 3);
    const legacy = createCipheriv('aes-256-gcm', TEST_KEK, iv);
    const ciphertext = Buffer.concat([legacy.update(JSON.stringify(credential)), legacy.final()]);
    const legacyRow = { ...original, wrapped: { iv, tag: legacy.getAuthTag(), ciphertext } };
    store.rows.set(id, legacyRow);
    await expect(vault.unwrapForTrade('user-a', id)).rejects.toBeInstanceOf(VenueVaultUnwrapFailedError);
    expect(store.rows.get(id)).toBe(legacyRow);
  });

  it('does not persist a key when encryption refuses an unset KEK', async () => {
    const store = new MemoryVenueVaultStore();
    const vault = new VenueVault(store, Buffer.alloc(0));
    await expect(
      vault.register('user-a', {
        venueId: 'venue-a',
        apiSecret: 'fixture-secret',
        apiKey: 'fixture-key',
        permissions: { scopes: ['trade'] },
      }),
    ).rejects.toBeInstanceOf(VenueVaultKekUnconfiguredError);
    expect(store.rows.size).toBe(0);
  });

  it('fail-closes when the wrap key is missing (HSM residual)', () => {
    expect(() => parseKek('')).toThrow(VenueVaultKekUnconfiguredError);
    expect(() => parseKek('aa')).toThrow(VenueVaultKekUnconfiguredError);
  });
});
