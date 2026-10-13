import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { getAddress as toChecksum } from 'viem';
import { MemoryEventBus } from '@intafaced/events';
import { AccountRegistry, MemoryAccountStore } from './accounts/registry.js';
import type { ProtocolChain } from './chain/client.js';
import { ChainObserver } from './events.js';

const CHAIN_ID = 8453;
const FACTORY: Address = '0x1111111111111111111111111111111111111111';
const IMPLEMENTATION: Address = '0x2222222222222222222222222222222222222222';
const DEPLOYED: Address = '0x3333333333333333333333333333333333333333';
const UNDEPLOYED: Address = '0x4444444444444444444444444444444444444444';
const FOREIGN: Address = '0x5555555555555555555555555555555555555555';
const SESSION: Address = '0x6666666666666666666666666666666666666666';
const OWNER: Address = '0x7777777777777777777777777777777777777777';
const TARGET: Address = '0x8888888888888888888888888888888888888888';
const REVOKER: Address = '0x9999999999999999999999999999999999999999';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const USER_SALT = `0x${'11'.repeat(32)}` as Hex;
const TX = `0x${'ab'.repeat(32)}` as Hex;
/** Above 2^53 so a number would lose the wei. The bus keeps the decimal string. */
const SPEND_LIMIT_WEI = 2n ** 80n;

interface SessionLog {
  args: Record<string, unknown>;
  address: Address;
  transactionHash: Hex | null;
}

interface WatchCall {
  address?: Address;
  event: { readonly name: string };
  onLogs: (logs: readonly SessionLog[]) => void;
}

function granted(address: Address, specHash: Hex): SessionLog {
  return {
    address,
    transactionHash: TX,
    args: {
      sessionKey: SESSION,
      specHash,
      validAfter: 10,
      validUntil: 1_700_000_000,
      spendLimitWei: SPEND_LIMIT_WEI,
      targets: [TARGET],
      selectors: ['0xa9059cbb' as Hex],
    },
  };
}

function revoked(address: Address): SessionLog {
  return {
    address,
    transactionHash: TX,
    args: { sessionKey: SESSION, revokedBy: REVOKER },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('session logs publish only for a registered factory account', () => {
  it('drops an unregistered look-alike and publishes registered accounts, deployed or not', async () => {
    const store = new MemoryAccountStore();
    const registry = new AccountRegistry(store, { chainId: CHAIN_ID, factory: FACTORY, implementation: IMPLEMENTATION });
    const row = {
      userId: USER_ID,
      chainId: CHAIN_ID,
      owner: OWNER,
      userSalt: USER_SALT,
      verifiedAt: null,
    };
    await store.upsert({ ...row, address: DEPLOYED, deployed: false });
    await store.upsert({ ...row, address: UNDEPLOYED, deployed: false });
    await registry.recordDeployment(DEPLOYED);
    expect((await registry.ownerOfRecord(DEPLOYED))?.deployed).toBe(true);
    expect((await registry.ownerOfRecord(UNDEPLOYED))?.deployed).toBe(false);
    expect(await registry.ownerOfRecord(FOREIGN)).toBeNull();

    const watches: WatchCall[] = [];
    const chain = {
      config: { chainId: CHAIN_ID, factory: FACTORY },
      client: {
        watchEvent(args: WatchCall) {
          watches.push(args);
          return () => {};
        },
      },
    } as unknown as ProtocolChain;
    const bus = new MemoryEventBus('svc-protocol');
    const errors: unknown[] = [];
    const observer = new ChainObserver({
      chain,
      bus,
      registry,
      onError: (err) => {
        errors.push(err);
      },
    });
    observer.start();

    const accountCreated = watches.find((watch) => watch.event.name === 'AccountCreated');
    expect(accountCreated?.address).toBe(FACTORY);
    const onGranted = watches.find((watch) => watch.event.name === 'SessionGranted');
    const onRevoked = watches.find((watch) => watch.event.name === 'SessionRevoked');
    expect(onGranted?.address).toBeUndefined();
    expect(onRevoked?.address).toBeUndefined();

    onGranted?.onLogs([
      granted(FOREIGN, `0x${'c1'.repeat(32)}` as Hex),
      granted(UNDEPLOYED, `0x${'c2'.repeat(32)}` as Hex),
      granted(DEPLOYED, `0x${'c3'.repeat(32)}` as Hex),
    ]);
    onRevoked?.onLogs([revoked(FOREIGN), revoked(UNDEPLOYED), revoked(DEPLOYED)]);
    await settle();
    observer.stop();

    expect(errors).toEqual([]);
    const created = bus.emitted('protocolSessionKeyCreated');
    const cancelled = bus.emitted('protocolSessionKeyCancelled');
    // UNDEPLOYED is registered (claimed) but recordDeployment has not run yet:
    // a grant in the deploy transaction must still be published. FOREIGN has no
    // registry row and is dropped.
    expect(created.map((event) => event.payload.account)).toEqual([toChecksum(UNDEPLOYED), toChecksum(DEPLOYED)]);
    expect(cancelled.map((event) => event.payload.account)).toEqual([toChecksum(UNDEPLOYED), toChecksum(DEPLOYED)]);
    expect(created.map((event) => event.payload.account)).not.toContain(toChecksum(FOREIGN));
    expect(created[1]?.payload.spendLimitWei).toBe(SPEND_LIMIT_WEI.toString());
    expect(typeof created[1]?.payload.spendLimitWei).toBe('string');
    expect(created[1]?.payload.validAfter).toBe(10);
    expect(created[1]?.payload.validUntil).toBe(1_700_000_000);
    expect(cancelled[1]?.payload.sessionKey).toBe(toChecksum(SESSION));
    expect(cancelled[1]?.payload.revokedBy).toBe(toChecksum(REVOKER));
  });
});
