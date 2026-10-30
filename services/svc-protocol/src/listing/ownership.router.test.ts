import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createEdgeContext } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import type { ListingChallenge, ListingStore, OwnershipChain } from './ownership.js';

const edge = createEdgeContext({ secret: 'a-protocol-listing-test-edge-secret-len', serviceName: 'svc-protocol' });
const anonymous = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-listing' });
const TOKEN = '0x00000000000000000000000000000000000a11ce' as Address;
const owner = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'43'.repeat(32)}`);

function listingCaller(over: { ttl?: number | null; read?: { owner: Address; blockNumber: bigint } | null } = {}) {
  const challenges = new Map<string, ListingChallenge>();
  const store: ListingStore = {
    putChallenge: async (c) => void challenges.set(c.nonce, { ...c, usedAt: null }),
    findChallenge: async (nonce) => challenges.get(nonce) ?? null,
    consume: async (nonce, usedAt) => {
      const c = challenges.get(nonce);
      if (!c || c.usedAt) return false;
      challenges.set(nonce, { ...c, usedAt });
      return true;
    },
    pruneExpired: async () => undefined,
  };
  const chain: OwnershipChain = {
    chainId: 84532,
    owner: async () => (over.read === undefined ? { owner: owner.address, blockNumber: 7n } : over.read),
    hasCode: async () => false,
    isValidSignature: async () => null,
  };
  const deps = {
    chain: { config: { chainId: 84532, rpcUrl: 'http://127.0.0.1:1' }, client: {} },
    registry: {},
    relay: {},
    relayEnabled: () => false,
    listing: { store, ttlSeconds: () => (over.ttl === undefined ? 300 : over.ttl), chain },
  } as unknown as ProtocolRouterDeps;
  return createProtocolRouter(deps).createCaller(anonymous()).listing;
}

describe('protocol.listing (D-launch-listing-01)', () => {
  it('a blank challenge lifetime and a token with no owner refuse before any challenge, as PRECONDITION_FAILED', async () => {
    await expect(listingCaller({ ttl: null }).ownershipChallenge({ token: TOKEN })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/lifetime is not set/),
    });
    await expect(listingCaller({ read: null }).ownershipChallenge({ token: TOKEN })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/names no owner/),
    });
  });

  it('proves the owner, then answers a replay CONFLICT, a stranger FORBIDDEN and an unknown nonce NOT_FOUND', async () => {
    const listing = listingCaller();
    const c = await listing.ownershipChallenge({ token: TOKEN });
    expect(c).toMatchObject({ chainId: 84532, token: getAddress(TOKEN) });
    const signature = await owner.signMessage({ message: c.message });
    await expect(listing.verifyOwnership({ nonce: c.nonce, signature })).resolves.toMatchObject({
      signer: owner.address,
      blockNumber: '7',
    });
    await expect(listing.verifyOwnership({ nonce: c.nonce, signature })).rejects.toMatchObject({ code: 'CONFLICT' });
    const next = await listing.ownershipChallenge({ token: TOKEN });
    await expect(
      listing.verifyOwnership({ nonce: next.nonce, signature: await stranger.signMessage({ message: next.message }) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(listing.verifyOwnership({ nonce: 'f'.repeat(32), signature })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a signature that is not 65 to 2048 whole bytes before reading anything', async () => {
    const listing = listingCaller();
    for (const signature of ['0x', '0xabc', `0x${'ab'.repeat(64)}`, `0x${'ab'.repeat(2049)}`])
      await expect(listing.verifyOwnership({ nonce: 'a'.repeat(32), signature })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
