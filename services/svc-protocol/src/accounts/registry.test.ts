import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { AccountRegistry, MemoryAccountStore } from './registry.js';

const ADDRESS: Address = '0x1111111111111111111111111111111111111111';
const OWNER: Address = '0x2222222222222222222222222222222222222222';
const CHAIN_ID = 8453;
const USER_A = '11111111-1111-4111-8111-111111111111';

async function seeded(identity?: ConstructorParameters<typeof AccountRegistry>[2]) {
  const store = new MemoryAccountStore();
  await store.upsert({
    userId: USER_A,
    chainId: CHAIN_ID,
    address: ADDRESS,
    owner: OWNER,
    userSalt: `0x${'0'.repeat(64)}`,
    deployed: false,
    verifiedAt: new Date(),
  });
  return { store, registry: new AccountRegistry(store, { chainId: CHAIN_ID }, identity) };
}

describe('account registry — a read model, not custody', () => {
  it('records deployment without ever touching the owner or the funds', async () => {
    const { registry } = await seeded();
    await registry.recordDeployment(ADDRESS);
    expect(await registry.ownerOfRecord(ADDRESS)).toMatchObject({ deployed: true, owner: OWNER, userId: USER_A });
  });

  it('answers null for an address it has no row for', async () => {
    const { registry } = await seeded();
    expect(await registry.ownerOfRecord('0x3333333333333333333333333333333333333333')).toBeNull();
  });
});

describe('a deployment is labelled with the chain it was seen on (chain identity)', () => {
  const GENESIS = `0x${'a'.repeat(64)}` as Hex;
  const RESTARTED = `0x${'b'.repeat(64)}` as Hex;

  it('stores the genesis read afresh, and the observer existence check never reads the chain', async () => {
    let genesisHash = GENESIS;
    let asked = 0;
    const { registry } = await seeded(async () => (asked++, { chainId: CHAIN_ID, genesisHash }));

    await registry.recordDeployment(ADDRESS);
    expect(await registry.ownerOfRecord(ADDRESS)).toMatchObject({ deployed: true, deployedGenesisHash: GENESIS });

    genesisHash = RESTARTED;
    const asking = asked;
    expect(await registry.ownerOfRecord(ADDRESS)).toMatchObject({ deployed: true, deployedGenesisHash: GENESIS });
    expect(asked).toBe(asking);

    await registry.recordDeployment(ADDRESS);
    expect(await registry.ownerOfRecord(ADDRESS)).toMatchObject({ deployed: true, deployedGenesisHash: RESTARTED });
  });

  it('records the deployment with no genesis when block 0 cannot be read, rather than dropping the event', async () => {
    const { registry } = await seeded(async () => Promise.reject(new Error('chain down')));
    await registry.recordDeployment(ADDRESS);
    expect(await registry.ownerOfRecord(ADDRESS)).toMatchObject({ deployed: true, deployedGenesisHash: null });
  });
});
