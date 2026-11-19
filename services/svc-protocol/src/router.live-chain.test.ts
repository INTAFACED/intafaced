import { beforeAll, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { createEdgeContext } from '@intafaced/contracts';
import { createProtocolRouter } from './router.js';
import { ProtocolChain } from './chain/client.js';
import { accountFactoryAbi, smartAccountAbi } from './chain/abi.js';
import { loadArtifact } from './chain/artifacts.js';
import { SessionRelay } from './session/relay.js';
import { DEFAULT_USER_SALT } from './accounts/address.js';
import {
  deployAccountSuite,
  devChainReachable,
  devChainRequired,
  devRpcUrl,
  devSuiteClients,
  suiteAccount,
  DEV_CHAIN_ID,
  type DevChainClients,
} from '../scripts/dev-chain.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SMART-ACCOUNT PROCEDURES, ON A REAL CHAIN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `chainStatus`, `predictAddress`, `buildSessionGrant`, `buildRevokeAllSessions`.
 *
 * Every existing test of these either stubs the chain (`router.mount.test.ts`
 * supplies `isDeployed: async () => false`, which is a plausible answer nobody
 * read from anywhere) or asserts the refusal. Both are correct and neither
 * demonstrates the happy path, because until now there was no chain to have one
 * on. `PROTOCOL_FACTORY_ADDRESS` was `0x0`, so `predictAddress` refused before
 * it did any arithmetic at all.
 *
 * This file wires the REAL `ProtocolChain` — the same class `index.ts` builds —
 * to a real anvil, deploys the real factory, and drives the real router. The
 * session the owner grants is read back off the account itself, not through
 * the service.
 *
 * Skips without a chain, hard-fails on CI where `REQUIRE_EVM_CHAIN=1`.
 * `router.mount.test.ts` is what proves the refusals still hold when it is
 * absent, and `chain/refusal-without-chain.test.ts` proves it against a real
 * dead socket rather than a stub.
 */

const rpcUrl = devRpcUrl();
const reachable = await devChainReachable(rpcUrl);

if (!reachable && devChainRequired()) {
  throw new Error(`REQUIRE_EVM_CHAIN=1 but no EVM RPC answered at ${rpcUrl}. Start it with: docker compose up -d evm`);
}

const ENTRYPOINT: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const edgeContext = createEdgeContext({ secret: 'a-protocol-live-chain-edge-secret-length', serviceName: 'svc-protocol' });
const anonymousContext = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-live-anon' });

describe.skipIf(!reachable)('svc-protocol against a real chain', () => {
  let factory: Address;
  let implementation: Address;
  let chain: ProtocolChain;
  let clients: DevChainClients;
  let anonCaller: ReturnType<ReturnType<typeof createProtocolRouter>['createCaller']>;

  /**
   * The owner IS the deployer here, because these tests must sign as the owner
   * (`grantSession` is owner-only). `suiteAccount(import.meta.url)` is the same account
   * `devSuiteClients` puts in the wallet below — derived from this file's path,
   * so no other suite can be sending from it. See `scripts/dev-chain.ts`.
   */
  const ownerAccount = suiteAccount(import.meta.url);

  beforeAll(async () => {
    clients = await devSuiteClients(import.meta.url, rpcUrl);
    const suite = await deployAccountSuite(clients, ENTRYPOINT);
    factory = suite.factory;
    implementation = suite.implementation;

    chain = new ProtocolChain({
      chainId: DEV_CHAIN_ID,
      rpcUrl,
      entryPoint: ENTRYPOINT,
      factory,
      implementation,
    });

    const router = createProtocolRouter({
      chain,
      relay: new SessionRelay(),
      relayEnabled: () => true,
      ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
      swapSlippageBps: () => null,
    });
    anonCaller = router.createCaller(anonymousContext());
  }, 60_000);

  const isLive = (account: Address, sessionKey: Address) =>
    clients.publicClient.readContract({ address: account, abi: smartAccountAbi, functionName: 'isSessionLive', args: [sessionKey] });
  const sessionOf = async (account: Address, sessionKey: Address) => {
    const record = await clients.publicClient.readContract({
      address: account,
      abi: smartAccountAbi,
      functionName: 'getSession',
      args: [sessionKey],
    });
    return { ...record, validUntil: Number(record.validUntil) };
  };

  // ── chainStatus ──────────────────────────────────────────────────────────

  it('reports a reachable chain with the suite verifiably deployed on it', async () => {
    const status = await anonCaller.chainStatus();
    expect(status).toMatchObject({
      reachable: true,
      configuredChainId: DEV_CHAIN_ID,
      observedChainId: DEV_CHAIN_ID,
      suiteConfigured: true,
      suiteDeployed: true,
      refusalCode: null,
      usable: true,
    });
    expect(BigInt(status.blockNumber!)).toBeGreaterThan(0n);
  });

  /**
   * `suiteDeployed` is a READ, not a restatement of config. Point the same
   * service at the same live chain with an address where nothing was deployed
   * and it must say so — otherwise wiring real addresses into compose would
   * hand back the exact dishonesty the typed refusals removed.
   */
  it('says the suite is not deployed when the configured address holds no code', async () => {
    const bogus: Address = '0x00000000000000000000000000000000deadbeef';
    const emptyChain = new ProtocolChain({ chainId: DEV_CHAIN_ID, rpcUrl, entryPoint: ENTRYPOINT, factory: bogus, implementation });
    const router = createProtocolRouter({
      chain: emptyChain,
      relay: new SessionRelay(),
      relayEnabled: () => true,
      ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
      swapSlippageBps: () => null,
    });
    await expect(router.createCaller(anonymousContext()).chainStatus()).resolves.toMatchObject({
      reachable: true,
      suiteConfigured: true,
      suiteDeployed: false,
      usable: false,
    });
  });

  // ── predictAddress ───────────────────────────────────────────────────────

  it('predicts an address, and the factory itself agrees with it', async () => {
    const result = await anonCaller.predictAddress({ owner: ownerAccount.address });

    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.chainId).toBe(DEV_CHAIN_ID);
    expect(result.factory.toLowerCase()).toBe(factory.toLowerCase());
    expect(result.implementation.toLowerCase()).toBe(implementation.toLowerCase());

    const onChain = (await clients.publicClient.readContract({
      address: factory,
      abi: loadArtifact('AccountFactory').abi,
      functionName: 'getAddress',
      args: [ownerAccount.address, DEFAULT_USER_SALT],
    })) as Address;
    expect(result.address.toLowerCase()).toBe(onChain.toLowerCase());
  });

  /**
   * `deployed` used to be whatever the stub said. It is now an `eth_getCode`,
   * and it has to change when the account is actually deployed — a flag that
   * never flips is not reporting anything.
   */
  it('reports deployed:false before deployment and true after', async () => {
    // Not an anvil account: nothing here needs to sign as this owner.
    const owner: Address = '0x00000000000000000000000000000000000000A1';
    await expect(anonCaller.predictAddress({ owner })).resolves.toMatchObject({ deployed: false });

    const hash = await clients.walletClient.writeContract({
      address: factory,
      abi: accountFactoryAbi,
      functionName: 'createAccount',
      args: [owner, DEFAULT_USER_SALT],
      account: clients.walletClient.account!,
      chain: clients.walletClient.chain,
    });
    await clients.publicClient.waitForTransactionReceipt({ hash });

    await expect(anonCaller.predictAddress({ owner })).resolves.toMatchObject({ deployed: true });
  }, 60_000);

  /**
   * The whole session lifecycle, through the service's own builders:
   * `buildSessionGrant` produces calldata → the OWNER signs and sends it (the
   * platform cannot; it holds no key for this account) → the account itself
   * answers what it stored.
   */
  it('reads a real granted session back off the chain', async () => {
    const owner = ownerAccount.address;
    const sessionKey: Address = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';

    const predicted = await anonCaller.predictAddress({ owner });
    if (!predicted.deployed) {
      const deployTx = await clients.walletClient.writeContract({
        address: factory,
        abi: accountFactoryAbi,
        functionName: 'createAccount',
        args: [owner, DEFAULT_USER_SALT],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      });
      await clients.publicClient.waitForTransactionReceipt({ hash: deployTx });
    }
    const account = predicted.address as Address;

    // A deployed account whose owner granted this key nothing.
    await expect(isLive(account, sessionKey)).resolves.toBe(false);

    const validUntil = Math.floor(Date.now() / 1000) + 3_600;
    const grant = await anonCaller.buildSessionGrant({
      account,
      spec: {
        key: sessionKey,
        validUntil,
        spendLimitWei: '1000000000000000',
        targets: ['0x2222222222222222222222222222222222222222'],
        // `swapExactIn(address,uint256,uint256,address)` — a venue call, not a transfer.
        selectors: ['0x9169558600000000000000000000000000000000000000000000000000000000'.slice(0, 10) as Hex],
      },
    });
    expect(grant.to.toLowerCase()).toBe(account.toLowerCase());

    const hash = await clients.walletClient.sendTransaction({
      to: grant.to as Address,
      data: grant.data as Hex,
      value: 0n,
      account: clients.walletClient.account!,
      chain: clients.walletClient.chain,
    });
    expect((await clients.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');

    await expect(isLive(account, sessionKey)).resolves.toBe(true);
    const stored = await sessionOf(account, sessionKey);
    expect(stored).toMatchObject({ validUntil, spentWei: 0n, revoked: false });
    // The commitment the account stored is the one the service said it would.
    expect(stored.specHash).toBe(grant.specHash);
  }, 90_000);

  /** The panic button, end to end: one call, every session dead. */
  it('reports a session as not live after the owner revokes it', async () => {
    const owner = ownerAccount.address;
    const sessionKey: Address = '0x976EA74026E726554dB657fA54763abd0C3a0aa9';
    const account = (await anonCaller.predictAddress({ owner })).address as Address;

    const validUntil = Math.floor(Date.now() / 1000) + 3_600;
    const grant = await anonCaller.buildSessionGrant({
      account,
      spec: {
        key: sessionKey,
        validUntil,
        spendLimitWei: '0',
        targets: ['0x2222222222222222222222222222222222222222'],
        selectors: ['0x91695586'],
      },
    });
    await clients.publicClient.waitForTransactionReceipt({
      hash: await clients.walletClient.sendTransaction({
        to: grant.to as Address,
        data: grant.data as Hex,
        value: 0n,
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    });
    await expect(isLive(account, sessionKey)).resolves.toBe(true);

    const revoke = await anonCaller.buildRevokeAllSessions({ account });
    await clients.publicClient.waitForTransactionReceipt({
      hash: await clients.walletClient.sendTransaction({
        to: revoke.to as Address,
        data: revoke.data as Hex,
        value: 0n,
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    });

    await expect(isLive(account, sessionKey)).resolves.toBe(false);
  }, 90_000);
});
