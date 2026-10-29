import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import {
  challengeTtlFromSetting,
  ERC1271_MAGIC,
  issueChallenge,
  LISTING_CHALLENGE_EXPIRED,
  LISTING_CHALLENGE_TTL_UNSET,
  LISTING_NONCE_UNKNOWN,
  LISTING_NONCE_USED,
  LISTING_NOT_OWNER,
  LISTING_OWNER_UNKNOWN,
  verifyOwnership,
  type ListingChallenge,
  type ListingStore,
  type OwnershipChain,
  type OwnershipProof,
} from './ownership.js';

// TEST keys: well-known development keys, never funded anywhere real.
const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const stranger = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const TOKEN = '0x4200000000000000000000000000000000000006' as Address;
const OWNER_CONTRACT = '0x00000000000000000000000000000000000c0dE1' as Address;
const T0 = new Date('2026-10-29T06:00:00.000Z');

function memoryStore() {
  const challenges = new Map<string, ListingChallenge>();
  const proofs: Omit<OwnershipProof, 'verifiedAt'>[] = [];
  const store: ListingStore = {
    putChallenge: async (c) => void challenges.set(c.nonce, { ...c, usedAt: null }),
    findChallenge: async (nonce) => challenges.get(nonce) ?? null,
    consume: async (nonce, usedAt, proof) => {
      const c = challenges.get(nonce);
      if (!c || c.usedAt) return false;
      challenges.set(nonce, { ...c, usedAt });
      proofs.push(proof);
      return true;
    },
  };
  return { store, proofs };
}

function chainWith(read: { owner: Address; blockNumber: bigint } | null, contract?: { accepts: Hex }): OwnershipChain {
  return {
    chainId: 84532,
    owner: async () => read,
    hasCode: async (account) => account.toLowerCase() === OWNER_CONTRACT.toLowerCase(),
    isValidSignature: async () => contract?.accepts ?? null,
  };
}

describe('ownership challenge lifetime setting', () => {
  it('is blank as null, whole seconds in bounds, and TEST only on the test stack', () => {
    expect(challengeTtlFromSetting(undefined, 'production')).toBeNull();
    expect(challengeTtlFromSetting('  ', 'production')).toBeNull();
    expect(challengeTtlFromSetting('600', 'production')).toBe(600);
    expect(challengeTtlFromSetting('TEST:300', 'test')).toBe(300);
    expect(() => challengeTtlFromSetting('TEST:300', 'production')).toThrow(/TEST value/);
    expect(() => challengeTtlFromSetting('5', 'test')).toThrow(/30 to 3600/);
    expect(() => challengeTtlFromSetting('ten', 'test')).toThrow(/whole seconds/);
  });
});

describe('contract ownership proof (D-launch-listing-01)', () => {
  it('refuses to issue a challenge while the lifetime is blank', async () => {
    const { store } = memoryStore();
    await expect(issueChallenge(store, null, 84532, TOKEN, T0)).rejects.toMatchObject({ code: LISTING_CHALLENGE_TTL_UNSET });
  });

  it('stores the proof for the owner’s signature; a replayed challenge refuses as used', async () => {
    const { store, proofs } = memoryStore();
    const challenge = await issueChallenge(store, 300, 84532, TOKEN, T0);
    expect(challenge.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(challenge.message).toContain(`token: ${TOKEN}`);
    expect(challenge.message).toContain('chain id: 84532');
    const signature = await owner.signMessage({ message: challenge.message });
    const chain = chainWith({ owner: owner.address, blockNumber: 77n });
    const proof = await verifyOwnership(store, chain, { nonce: challenge.nonce, signature }, new Date(T0.getTime() + 1000));
    expect(proof).toMatchObject({ signer: owner.address, token: TOKEN, blockNumber: 77n, nonce: challenge.nonce });
    expect(proofs).toHaveLength(1);
    await expect(verifyOwnership(store, chain, { nonce: challenge.nonce, signature }, new Date(T0.getTime() + 2000))).rejects.toMatchObject(
      {
        code: LISTING_NONCE_USED,
      },
    );
    expect(proofs).toHaveLength(1);
  });

  it('refuses a signer who is not the owner, and a token with no readable owner, storing nothing', async () => {
    const { store, proofs } = memoryStore();
    const first = await issueChallenge(store, 300, 84532, TOKEN, T0);
    const wrong = await stranger.signMessage({ message: first.message });
    await expect(
      verifyOwnership(store, chainWith({ owner: owner.address, blockNumber: 1n }), { nonce: first.nonce, signature: wrong }, T0),
    ).rejects.toMatchObject({ code: LISTING_NOT_OWNER });
    const second = await issueChallenge(store, 300, 84532, TOKEN, T0);
    const right = await owner.signMessage({ message: second.message });
    await expect(verifyOwnership(store, chainWith(null), { nonce: second.nonce, signature: right }, T0)).rejects.toMatchObject({
      code: LISTING_OWNER_UNKNOWN,
    });
    expect(proofs).toHaveLength(0);
  });

  it('refuses an unknown nonce, an expired challenge and a challenge from another chain', async () => {
    const { store } = memoryStore();
    const chain = chainWith({ owner: owner.address, blockNumber: 1n });
    await expect(verifyOwnership(store, chain, { nonce: 'f'.repeat(32), signature: '0x' }, T0)).rejects.toMatchObject({
      code: LISTING_NONCE_UNKNOWN,
    });
    const challenge = await issueChallenge(store, 60, 84532, TOKEN, T0);
    const signature = await owner.signMessage({ message: challenge.message });
    await expect(
      verifyOwnership(store, chain, { nonce: challenge.nonce, signature }, new Date(T0.getTime() + 60_000)),
    ).rejects.toMatchObject({
      code: LISTING_CHALLENGE_EXPIRED,
    });
    const other = await issueChallenge(store, 60, 31337, TOKEN, T0);
    const signed = await owner.signMessage({ message: other.message });
    await expect(verifyOwnership(store, chain, { nonce: other.nonce, signature: signed }, T0)).rejects.toMatchObject({
      code: LISTING_NONCE_UNKNOWN,
    });
  });

  it('accepts a contract owner only through its ERC-1271 answer', async () => {
    const { store, proofs } = memoryStore();
    const challenge = await issueChallenge(store, 300, 84532, TOKEN, T0);
    const signature = await stranger.signMessage({ message: challenge.message });
    await expect(
      verifyOwnership(
        store,
        chainWith({ owner: OWNER_CONTRACT, blockNumber: 5n }, { accepts: '0xffffffff' }),
        { nonce: challenge.nonce, signature },
        T0,
      ),
    ).rejects.toMatchObject({ code: LISTING_NOT_OWNER });
    const proof = await verifyOwnership(
      store,
      chainWith({ owner: OWNER_CONTRACT, blockNumber: 5n }, { accepts: ERC1271_MAGIC }),
      { nonce: challenge.nonce, signature },
      T0,
    );
    expect(proof.signer).toBe(OWNER_CONTRACT);
    expect(proofs).toHaveLength(1);
  });
});
