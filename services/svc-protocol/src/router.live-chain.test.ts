import { beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createProtocolRouter } from './router.js';
import { ProtocolChain } from './chain/client.js';
import { accountFactoryAbi } from './chain/abi.js';
import { getUserOperationHash } from './chain/userop.js';
import { loadArtifact } from './chain/artifacts.js';
import { AccountRegistry, bindingMessage, MemoryAccountStore } from './accounts/registry.js';
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
 * THE FOUR PROCEDURES THAT HAVE NEVER RETURNED A VALUE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `predictAddress`, `buildDeployment`, `sessionStatus`, `claimAccount`.
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
 * only things faked are the ones that are not chain state: the registry's
 * storage (`MemoryAccountStore`, as `registry.test.ts` already uses) and the
 * edge principal, which is signed for real with a test secret.
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
const SECRET = 'a-protocol-live-chain-edge-secret-length';
const USER = '11111111-1111-4111-8111-111111111111';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });

function signedContext() {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['protocol:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-live',
  });
}

const anonymousContext = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-live-anon' });

describe.skipIf(!reachable)('svc-protocol against a real chain', () => {
  let factory: Address;
  let implementation: Address;
  let chain: ProtocolChain;
  let clients: DevChainClients;
  let caller: ReturnType<ReturnType<typeof createProtocolRouter>['createCaller']>;
  let anonCaller: ReturnType<ReturnType<typeof createProtocolRouter>['createCaller']>;

  /**
   * The owner IS the deployer here, because these tests must sign as the owner
   * (`grantSession` is owner-only, and `claimAccount` needs the owner's
   * signature). `suiteAccount(import.meta.url)` is the same account
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

    const registry = new AccountRegistry(new MemoryAccountStore(), { chainId: DEV_CHAIN_ID, factory, implementation });
    const router = createProtocolRouter({
      chain,
      registry,
      relay: new SessionRelay(chain),
      relayEnabled: () => true,
      ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
      swapSlippageBps: () => null,
    });
    caller = router.createCaller(signedContext());
    anonCaller = router.createCaller(anonymousContext());
  }, 60_000);

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
      registry: new AccountRegistry(new MemoryAccountStore(), { chainId: DEV_CHAIN_ID, factory: bogus, implementation }),
      relay: new SessionRelay(emptyChain),
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

  // ── buildDeployment ──────────────────────────────────────────────────────

  /**
   * The calldata is unsigned and anyone may send it — that is the point. This
   * asserts it is calldata the deployed factory actually accepts, by sending it
   * as a raw transaction rather than through viem's encoder a second time.
   */
  it('builds deployment calldata the real factory executes', async () => {
    const owner: Address = '0x00000000000000000000000000000000000000b2';
    const built = await anonCaller.buildDeployment({ owner });

    expect(built.to.toLowerCase()).toBe(factory.toLowerCase());
    expect(built.value).toBe('0');

    const decoded = decodeFunctionData({ abi: accountFactoryAbi, data: built.data as Hex });
    expect(decoded.functionName).toBe('createAccount');
    expect(decoded.args?.[0]).toBe(owner);

    const hash = await clients.walletClient.sendTransaction({
      to: built.to as Address,
      data: built.data as Hex,
      value: 0n,
      account: clients.walletClient.account!,
      chain: clients.walletClient.chain,
    });
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');

    const code = await clients.publicClient.getCode({ address: built.predictedAddress as Address });
    expect(code, 'the account did not land at the address buildDeployment promised').not.toBe('0x');
    expect(code).toBeDefined();
  }, 60_000);

  // ── sessionStatus ────────────────────────────────────────────────────────

  it('refuses sessionStatus for an address that holds no code, instead of saying "no session"', async () => {
    const undeployed = (await anonCaller.predictAddress({ owner: '0x00000000000000000000000000000000000000c3' })).address;
    await expect(anonCaller.sessionStatus({ account: undeployed, sessionKey: ownerAccount.address })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('protocol.contract_not_deployed'),
    });
  });

  /**
   * The whole session lifecycle, through the service's own builders:
   * `buildSessionGrant` produces calldata → the OWNER signs and sends it (the
   * platform cannot; it holds no key for this account) → `sessionStatus` reads
   * back what the chain stored.
   *
   * `exists: false` before and `exists: true` after is the assertion that makes
   * the negative answer trustworthy. It is the same shape the service returns
   * when it could not read anything, which is exactly why #193 made the
   * unreadable case refuse.
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

    // A deployed account whose owner granted this key nothing. THIS is the only
    // situation allowed to answer exists:false.
    await expect(anonCaller.sessionStatus({ account, sessionKey })).resolves.toMatchObject({
      exists: false,
      live: false,
      spentWei: null,
    });

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

    const status = await anonCaller.sessionStatus({ account, sessionKey });
    expect(status).toMatchObject({
      exists: true,
      live: true,
      validUntil,
      spentWei: '0',
      revoked: false,
    });
    // The commitment the account stored is the one the service said it would.
    expect(status.specHash).toBe(grant.specHash);
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
    await expect(anonCaller.sessionStatus({ account, sessionKey })).resolves.toMatchObject({ live: true });

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

    await expect(anonCaller.sessionStatus({ account, sessionKey })).resolves.toMatchObject({ live: false });
  }, 90_000);

  // ── claimAccount ─────────────────────────────────────────────────────────

  /**
   * The registry is a read model, not custody — but `deployed` on the record it
   * writes comes from the chain, and that read had never happened. A claim made
   * with no chain refuses; a claim made here records what is actually there.
   */
  it('claims a deployed account and records the deployment state it read', async () => {
    const owner = ownerAccount.address;
    const predicted = await anonCaller.predictAddress({ owner });
    expect(predicted.deployed).toBe(true);

    const signature = await ownerAccount.signMessage({
      message: bindingMessage({ userId: USER, chainId: DEV_CHAIN_ID, address: predicted.address as Address }),
    });

    await expect(caller.claimAccount({ owner, address: predicted.address, signature })).resolves.toMatchObject({
      address: predicted.address,
      owner,
      deployed: true,
    });
    await expect(caller.myAccounts({ limit: 50 })).resolves.toHaveLength(1);
  }, 60_000);

  it('claims an undeployed account as deployed:false — the address exists before the code does', async () => {
    const undeployedOwner = privateKeyToAccount(`0x${'5a'.repeat(32)}` as Hex);
    const predicted = await anonCaller.predictAddress({ owner: undeployedOwner.address });
    expect(predicted.deployed).toBe(false);

    const signature = await undeployedOwner.signMessage({
      message: bindingMessage({ userId: USER, chainId: DEV_CHAIN_ID, address: predicted.address as Address }),
    });

    await expect(caller.claimAccount({ owner: undeployedOwner.address, address: predicted.address, signature })).resolves.toMatchObject({
      deployed: false,
    });
  }, 60_000);

  it('still refuses a claim whose signature is not the owner key', async () => {
    const impostor = privateKeyToAccount(`0x${'7b'.repeat(32)}` as Hex);
    const victimOwner = privateKeyToAccount(`0x${'6c'.repeat(32)}` as Hex);
    const predicted = await anonCaller.predictAddress({ owner: victimOwner.address });

    const signature = await impostor.signMessage({
      message: bindingMessage({ userId: USER, chainId: DEV_CHAIN_ID, address: predicted.address as Address }),
    });

    await expect(caller.claimAccount({ owner: victimOwner.address, address: predicted.address, signature })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  // ── what a dev chain still cannot do ─────────────────────────────────────

  function userOp(account: string, signature: Hex) {
    return {
      sender: account,
      nonce: '0',
      callData: '0x' as Hex,
      callGasLimit: '100000',
      verificationGasLimit: '100000',
      preVerificationGas: '50000',
      maxFeePerGas: '1000000000',
      maxPriorityFeePerGas: '1000000000',
      signature,
    };
  }

  /**
   * FOUND BY GIVING THIS PATH A CHAIN TO STAND ON.
   *
   * With no chain, `relayUserOperation` never got past the first read, so the
   * envelope decoder was unreachable in practice. With one, a malformed
   * signature reached `decodeSignatureEnvelope`, threw `SignatureEnvelopeError`,
   * and — because nothing in `toTrpcError` recognised it — arrived at the caller
   * as `INTERNAL_SERVER_ERROR: 'Protocol request failed'`. A 500 for the
   * caller's own malformed bytes invites a retry that can never succeed and
   * hides the reason. It is a 400 now.
   */
  it('calls a malformed signature envelope a bad request, not a server error', async () => {
    const account = (await anonCaller.predictAddress({ owner: ownerAccount.address })).address;
    await expect(anonCaller.relayUserOperation({ account, userOp: userOp(account, '0x') })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('signature envelope'),
    });
  });

  /**
   * Stated as a test so it cannot be forgotten. Anvil gives us a chain; it does
   * not give us an ERC-4337 EntryPoint (a public singleton we do not own and
   * which is not in this repository) or a bundler. So relaying still refuses
   * here even for a correctly signed operation — `relay.bundler_unavailable`,
   * with the note that the user can submit it themselves. That is the honest
   * answer, not a regression, and it is why `socket.evm-bundler` stays open.
   */
  it('still refuses to relay a correctly signed operation: no bundler on a dev chain', async () => {
    const owner = ownerAccount.address;
    const account = (await anonCaller.predictAddress({ owner })).address as Address;

    const op = userOp(account, '0x');
    const hash = getUserOperationHash({
      userOp: {
        sender: account,
        nonce: 0n,
        callData: '0x',
        callGasLimit: 100_000n,
        verificationGasLimit: 100_000n,
        preVerificationGas: 50_000n,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        signature: '0x',
      },
      entryPoint: ENTRYPOINT,
      chainId: DEV_CHAIN_ID,
    });
    // Mode byte 0x00 = owner, then the owner's own 65-byte signature.
    const signature = `0x00${(await ownerAccount.signMessage({ message: { raw: hash } })).slice(2)}` as Hex;

    await expect(anonCaller.relayUserOperation({ account, userOp: { ...op, signature } })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('No bundler configured'),
    });
  }, 60_000);
});
