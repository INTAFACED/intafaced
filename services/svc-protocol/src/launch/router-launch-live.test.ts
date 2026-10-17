import { beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { createEdgeContext } from '@intafaced/contracts';
import { createProtocolRouter } from '../router.js';
import { ProtocolChain } from '../chain/client.js';
import { AccountRegistry, MemoryAccountStore } from '../accounts/registry.js';
import { SessionRelay } from '../session/relay.js';
import { templateArtifact } from './address.js';
import {
  deployTokenFactory,
  devChainReachable,
  devChainRequired,
  devRpcUrl,
  devSuiteClients,
  DEV_CHAIN_ID,
  type DevChainClients,
} from '../../scripts/dev-chain.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WHOLE LAUNCH, THROUGH THE ROUTER, AGAINST A REAL CHAIN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `token-factory-onchain.test.ts` proves the contracts behave. This proves the
 * SERVICE does, which is a different claim — everything a creator ever touches
 * is the router, not the contracts.
 *
 * The load-bearing detail is that this test never builds its own calldata. It
 * takes the exact bytes `buildTokenDeployment` returned, broadcasts those, and
 * checks the token landed where `predictTokenAddress` said it would. A test
 * that hand-assembled the call would prove the contracts agree with the test,
 * which is not the question. The question is whether the two procedures a
 * creator actually uses agree with EACH OTHER and with the chain.
 *
 * That is the failure this rules out: a service that predicts one address and
 * hands out calldata deploying to another. Both halves look correct in
 * isolation, and every launch goes to an address nobody was shown.
 *
 * Needs a chain (`docker compose up -d evm`); skips loudly without one, and is
 * a hard failure on CI where `REQUIRE_EVM_CHAIN=1`.
 */

const rpcUrl = devRpcUrl();
const reachable = await devChainReachable(rpcUrl);

if (!reachable && devChainRequired()) {
  throw new Error(
    `REQUIRE_EVM_CHAIN=1 but no EVM RPC answered at ${rpcUrl}. This suite proves the router's predicted address and ` +
      `its own calldata agree on a real chain; it must not be skipped on CI. Start it with: docker compose up -d evm`,
  );
}

/**
 * Sends from an account derived from this file's own path, funded on demand —
 * see the per-suite sender banner in `scripts/dev-chain.ts`. It used to name a
 * hand-picked anvil index here, and `amm/mint-swap-onchain.test.ts` had picked
 * the same one.
 */
const ENTRYPOINT: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

const anonymous = () =>
  createEdgeContext({ secret: 'a-launch-live-suite-edge-secret-long-enough', serviceName: 'svc-protocol' })({
    headers: { 'x-intafaced-region': 'DE' },
    id: 'req-launch-live',
  });

describe.skipIf(!reachable)('launch through the router, on a real chain', () => {
  let clients: DevChainClients;
  let tokenFactory: Address;
  let caller: ReturnType<ReturnType<typeof createProtocolRouter>['createCaller']>;

  beforeAll(async () => {
    clients = await devSuiteClients(import.meta.url, rpcUrl);
    ({ factory: tokenFactory } = await deployTokenFactory(clients));

    const chain = new ProtocolChain({
      chainId: DEV_CHAIN_ID,
      rpcUrl,
      entryPoint: ENTRYPOINT,
      // The smart-account suite is deliberately NOT deployed in this fixture.
      // Launch must work without it — they are separate features and neither
      // may gate the other, which is exactly why `suiteDeployed` and
      // `tokenFactoryDeployed` are two booleans rather than one.
      factory: ZERO,
      implementation: ZERO,
      tokenFactory,
    });

    caller = createProtocolRouter({
      chain,
      registry: new AccountRegistry(new MemoryAccountStore(), { chainId: DEV_CHAIN_ID, factory: ZERO, implementation: ZERO }),
      relay: new SessionRelay(chain),
      relayEnabled: () => true,
      ammFactoryAddress: () => ZERO,
      swapSlippageBps: () => null,
    }).createCaller(anonymous());
  }, 60_000);

  it('reports launch usable while the smart-account suite is not — they are independent', async () => {
    await expect(caller.launch.status()).resolves.toMatchObject({
      chainId: DEV_CHAIN_ID,
      factory: tokenFactory,
      configured: true,
      deployed: true,
      usable: true,
      refusalCode: null,
      mintAuthorityRetained: false,
      template: { contractName: 'SovereignToken', sourceHash: templateArtifact().sourceHash, audited: false },
    });

    await expect(caller.chainStatus()).resolves.toMatchObject({
      reachable: true,
      suiteConfigured: false,
      suiteDeployed: false,
      usable: false,
      tokenFactoryConfigured: true,
      tokenFactoryDeployed: true,
      launchUsable: true,
    });
  });

  /**
   * THE END-TO-END. Predict, build, broadcast the bytes we were handed, and
   * confirm the token is at the predicted address with the promised supply.
   */
  it('predicts an address, and its own calldata deploys the token there', async () => {
    const creator = clients.deployer;
    const recipient: Address = '0x00000000000000000000000000000000000000d4';
    const userSalt = keccak256(toHex('router-e2e'));
    const params = { name: 'Router End To End', symbol: 'E2E', decimals: 18, totalSupply: '1000000', recipient };

    const predicted = await caller.launch.predictTokenAddress({ creator, userSalt, params });
    expect(predicted.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(predicted.deployed, 'nothing should be there yet').toBe(false);
    expect(predicted.scaledTotalSupply).toBe((10n ** 24n).toString());
    expect(predicted.factory).toBe(tokenFactory);

    const call = await caller.launch.buildTokenDeployment({ creator, userSalt, params });
    expect(call.to).toBe(tokenFactory);
    expect(call.value).toBe('0');
    expect(call.predictedAddress, 'the two procedures must agree with each other').toBe(predicted.address);

    // Broadcast EXACTLY the bytes the service handed out. No re-encoding here,
    // because re-encoding would test viem rather than the service.
    const hash = await clients.walletClient.sendTransaction({
      account: clients.walletClient.account!,
      chain: clients.walletClient.chain,
      to: call.to as Address,
      data: call.data as Hex,
      value: 0n,
    });
    expect((await clients.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');

    // The service now agrees that the address it predicted holds a token.
    await expect(caller.launch.predictTokenAddress({ creator, userSalt, params })).resolves.toMatchObject({
      address: predicted.address,
      deployed: true,
    });

    const info = await caller.launch.tokenInfo({ token: predicted.address as Address });
    expect(info).toMatchObject({
      name: 'Router End To End',
      symbol: 'E2E',
      decimals: 18,
      totalSupply: (10n ** 24n).toString(),
      fromThisFactory: true,
      // Masked over the three immutables — see `deployedCodeMatches`.
      matchesTemplate: true,
    });
    expect(info.initialHolder.toLowerCase()).toBe(recipient.toLowerCase());
    expect(info.creator!.toLowerCase()).toBe(creator.toLowerCase());
  }, 60_000);

  /**
   * The factory is not an ERC-20, so the metadata read refuses rather than
   * inventing a name. That is the half worth pinning: there is no path here
   * that returns a plausible-looking empty token for a contract that is not one.
   */
  it('refuses to describe a contract that is not a token, rather than inventing metadata', async () => {
    await expect(caller.launch.tokenInfo({ token: tokenFactory })).rejects.toThrow();
  }, 60_000);

  it('refuses tokenInfo for an address with no code, rather than empty metadata', async () => {
    await expect(caller.launch.tokenInfo({ token: '0x00000000000000000000000000000000deadbeef' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('protocol.contract_not_deployed'),
    });
  }, 60_000);
});
