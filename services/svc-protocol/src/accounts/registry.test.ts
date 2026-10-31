import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { AccountRegistry, bindingMessage, ClaimRefusedError, MemoryAccountStore } from './registry.js';

const FACTORY: Address = '0x1111111111111111111111111111111111111111';
const IMPLEMENTATION: Address = '0x2222222222222222222222222222222222222222';
const CHAIN_ID = 8453;

const ownerAccount = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex);
const impostor = privateKeyToAccount(`0x${'22'.repeat(32)}` as Hex);

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function newRegistry() {
  const store = new MemoryAccountStore();
  return {
    store,
    registry: new AccountRegistry(store, { chainId: CHAIN_ID, factory: FACTORY, implementation: IMPLEMENTATION }),
  };
}

async function sign(userId: string, address: Address, signer = ownerAccount): Promise<Hex> {
  return signer.signMessage({ message: bindingMessage({ userId, chainId: CHAIN_ID, address }) });
}

describe('account registry — a read model, not custody', () => {
  it('links an address to a user id on proof of the owner key', async () => {
    const { registry } = newRegistry();
    const address = registry.predict(ownerAccount.address);

    const record = await registry.claim({
      userId: USER_A,
      owner: ownerAccount.address,
      address,
      signature: await sign(USER_A, address),
      deployed: false,
    });

    expect(record.address).toBe(address);
    expect(record.owner).toBe(ownerAccount.address);
    expect(record.verifiedAt).toBeInstanceOf(Date);
    expect(await registry.accountsOf(USER_A, 50)).toHaveLength(1);
  });

  it('refuses an address that is not the CREATE2 address of the claimed owner', async () => {
    const { registry } = newRegistry();
    const someoneElses: Address = '0x9999999999999999999999999999999999999999';

    await expect(
      registry.claim({
        userId: USER_A,
        owner: ownerAccount.address,
        address: someoneElses,
        signature: await sign(USER_A, someoneElses),
        deployed: true,
      }),
    ).rejects.toMatchObject({ code: 'registry.address_mismatch' });
  });

  it('refuses a signature from anyone but the owner key', async () => {
    const { registry } = newRegistry();
    const address = registry.predict(ownerAccount.address);

    await expect(
      registry.claim({
        userId: USER_A,
        owner: ownerAccount.address,
        address,
        signature: await sign(USER_A, address, impostor),
        deployed: false,
      }),
    ).rejects.toBeInstanceOf(ClaimRefusedError);
  });

  it('refuses a signature bound to a different user id', async () => {
    const { registry } = newRegistry();
    const address = registry.predict(ownerAccount.address);

    // The user id is inside the signed message, so a signature captured for one
    // profile cannot be replayed to attach the account to another.
    await expect(
      registry.claim({
        userId: USER_B,
        owner: ownerAccount.address,
        address,
        signature: await sign(USER_A, address),
        deployed: false,
      }),
    ).rejects.toBeInstanceOf(ClaimRefusedError);
  });

  it('refuses to move an account between profiles', async () => {
    const { registry } = newRegistry();
    const address = registry.predict(ownerAccount.address);

    await registry.claim({
      userId: USER_A,
      owner: ownerAccount.address,
      address,
      signature: await sign(USER_A, address),
      deployed: false,
    });

    await expect(
      registry.claim({
        userId: USER_B,
        owner: ownerAccount.address,
        address,
        signature: await sign(USER_B, address),
        deployed: false,
      }),
    ).rejects.toMatchObject({ code: 'registry.already_claimed' });
  });

  it('is idempotent for the same user — re-claiming updates, never duplicates', async () => {
    const { registry } = newRegistry();
    const address = registry.predict(ownerAccount.address);
    const signature = await sign(USER_A, address);

    const first = await registry.claim({
      userId: USER_A,
      owner: ownerAccount.address,
      address,
      signature,
      deployed: false,
    });
    const second = await registry.claim({
      userId: USER_A,
      owner: ownerAccount.address,
      address,
      signature,
      deployed: true,
    });

    expect(second.id).toBe(first.id);
    expect(second.deployed).toBe(true);
    expect(await registry.accountsOf(USER_A, 50)).toHaveLength(1);
  });

  it('gives one owner distinct accounts per salt', async () => {
    const { registry } = newRegistry();
    const second = `0x${'00'.repeat(31)}07` as Hex;
    expect(registry.predict(ownerAccount.address)).not.toBe(registry.predict(ownerAccount.address, second));
  });

  it('records deployment without ever touching the owner or the funds', async () => {
    const { registry } = newRegistry();
    const address = registry.predict(ownerAccount.address);
    await registry.claim({
      userId: USER_A,
      owner: ownerAccount.address,
      address,
      signature: await sign(USER_A, address),
      deployed: false,
    });

    await registry.recordDeployment(address);
    expect((await registry.ownerOfRecord(address))?.deployed).toBe(true);
  });
});

describe('deployed holds only on the chain it was seen on (chain identity)', () => {
  const GENESIS = `0x${'a'.repeat(64)}` as Hex;
  const RESTARTED = `0x${'b'.repeat(64)}` as Hex;

  it('a TEST chain started again reads an account deployed on the old one as not deployed, until it is deployed again', async () => {
    const store = new MemoryAccountStore();
    let genesisHash = GENESIS;
    let asked = 0;
    const identity = async () => (asked++, { chainId: CHAIN_ID, genesisHash });
    const registry = new AccountRegistry(store, { chainId: CHAIN_ID, factory: FACTORY, implementation: IMPLEMENTATION }, identity);
    const address = registry.predict(ownerAccount.address);
    await registry.claim({ userId: USER_A, owner: ownerAccount.address, address, signature: await sign(USER_A, address), deployed: true });
    expect((await registry.accountsOf(USER_A, 10))[0]).toMatchObject({ deployed: true, deployedGenesisHash: GENESIS });

    genesisHash = RESTARTED;
    expect((await registry.accountsOf(USER_A, 10))[0]?.deployed).toBe(false);
    // The observer's existence check never reads the chain: it gets the stored row as it is.
    const asking = asked;
    expect(await registry.ownerOfRecord(address)).not.toBeNull();
    expect(asked).toBe(asking);

    await registry.recordDeployment(address);
    expect((await registry.accountsOf(USER_A, 10))[0]).toMatchObject({ deployed: true, deployedGenesisHash: RESTARTED });

    // A row that names no deployment needs no chain read.
    const before = asked;
    const other = registry.predict(impostor.address);
    await registry.claim({
      userId: USER_B,
      owner: impostor.address,
      address: other,
      signature: await sign(USER_B, other, impostor),
      deployed: false,
    });
    const beforeList = asked;
    await registry.accountsOf(USER_B, 10);
    expect(asked).toBe(beforeList);
    expect(beforeList).toBe(before);
  });

  it('a deployment stored before the genesis column keeps its meaning', async () => {
    const store = new MemoryAccountStore();
    const identity = async () => ({ chainId: CHAIN_ID, genesisHash: RESTARTED });
    const registry = new AccountRegistry(store, { chainId: CHAIN_ID, factory: FACTORY, implementation: IMPLEMENTATION }, identity);
    const address = registry.predict(ownerAccount.address);
    await store.upsert({
      userId: USER_A,
      chainId: CHAIN_ID,
      address,
      owner: ownerAccount.address,
      userSalt: `0x${'0'.repeat(64)}`,
      deployed: true,
      verifiedAt: new Date(),
    });
    expect((await registry.accountsOf(USER_A, 10))[0]?.deployed).toBe(true);
  });
});

describe('the binding message grants nothing', () => {
  it('names the account, the chain and the user, and says so in words', () => {
    const message = bindingMessage({ userId: USER_A, chainId: CHAIN_ID, address: FACTORY });
    expect(message).toContain(FACTORY);
    expect(message).toContain(String(CHAIN_ID));
    expect(message).toContain(USER_A);
    expect(message).toContain('grants no permission over the account and moves no funds');
  });

  it('differs per chain, so a signature cannot be replayed across deployments', () => {
    const a = bindingMessage({ userId: USER_A, chainId: 1, address: FACTORY });
    const b = bindingMessage({ userId: USER_A, chainId: 8453, address: FACTORY });
    expect(a).not.toBe(b);
  });
});
