/**
 * The public-test-chain deploy (`scripts/deploy-sepolia.ts` → `deployProtocolSuite`) run against the local dev chain.
 * Proves it deploys every contract wired as the services read it, prints the settings both services need, and refuses
 * a public dev key, a wrong chain and a wrong quote token before sending anything.
 * Skips without anvil; CI with REQUIRE_EVM_CHAIN=1 must run this.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { KNOWN_DEV_PRIVATE_KEYS } from '@intafaced/config';
import { loadArtifact } from '../chain/artifacts.js';
import { deployEnvLines, deployProtocolSuite, SUITE_MARKET_ID, type DeployTarget } from './deploy-suite.js';
import { ENTRYPOINT_V07 } from './sepolia-deploy-env.js';

const devChainMod = await (async () => {
  try {
    return await import('../../scripts/dev-chain.js');
  } catch {
    return null;
  }
})();

const chainUp = devChainMod ? await devChainMod.devChainReachable() : false;
const describeOnChain = !devChainMod || (!chainUp && !devChainMod.devChainRequired()) ? describe.skip : describe;

describeOnChain('the testnet deploy script on a local chain', () => {
  if (!devChainMod) return;

  let suite: Awaited<ReturnType<typeof devChainMod.devSuiteClients>>;
  let usdc: Address;
  let target: DeployTarget;

  const deployToken = async (decimals: number): Promise<Address> => {
    const art = loadArtifact('MockERC20Dec');
    const hash = await suite.walletClient.deployContract({
      abi: art.abi,
      bytecode: art.bytecode,
      args: [decimals],
      account: suite.walletClient.account!,
      chain: suite.walletClient.chain,
    });
    const receipt = await suite.publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!;
  };

  const freshFundedKey = async (): Promise<Hex> => {
    const key = generatePrivateKey();
    await devChainMod.fundDevAccount(suite.publicClient, privateKeyToAccount(key).address);
    return key;
  };

  beforeAll(async () => {
    if (!chainUp && devChainMod.devChainRequired()) {
      throw new Error('REQUIRE_EVM_CHAIN=1 but no RPC at ' + devChainMod.devRpcUrl());
    }
    // Asserts the node is a disposable anvil on the dev chain id before anything is written to it.
    suite = await devSuiteClients();
    usdc = await deployToken(6);
    target = {
      chainId: devChainMod.DEV_CHAIN_ID,
      chainName: 'local-dev',
      rpcUrl: suite.rpcUrl,
      deployerKey: await freshFundedKey(),
      entryPoint: ENTRYPOINT_V07,
      usdc,
      rpcNote: 'local dev chain (test)',
    };
  });

  function devSuiteClients() {
    return devChainMod!.devSuiteClients(import.meta.url);
  }

  it('deploys every contract with code, wired as the services read them, and prints both services’ settings', async () => {
    const deployed = await deployProtocolSuite(target);
    const names = deployed.registry.contracts.map((c) => c.name);
    expect(names).toEqual([
      'TEST',
      'SmartAccount',
      'AccountFactory',
      'TokenFactory',
      'PoolFactory',
      'SovereignVenue',
      'ScopedPaymaster',
      'SovereignEscrow',
    ]);
    for (const c of deployed.registry.contracts) {
      const code = await suite.publicClient.getCode({ address: c.address as Address });
      expect(code && code.length > 2, `${c.name} has code`).toBe(true);
      expect(c.sourceHash).toBe(loadArtifact(c.name === 'TEST' ? 'MockERC20' : (c.name as 'SmartAccount')).sourceHash);
    }
    const at = (name: string) => deployed.registry.contracts.find((c) => c.name === name)!.address as Address;

    const venue = loadArtifact('SovereignVenue');
    const read = (address: Address, abi: typeof venue.abi, functionName: string) =>
      suite.publicClient.readContract({ address, abi, functionName } as never) as Promise<unknown>;
    expect(String(await read(at('SovereignVenue'), venue.abi, 'quoteToken')).toLowerCase()).toBe(usdc.toLowerCase());
    expect(String(await read(at('SovereignVenue'), venue.abi, 'baseToken')).toLowerCase()).toBe(at('TEST').toLowerCase());
    expect(await read(at('SovereignVenue'), venue.abi, 'marketId')).toBe(SUITE_MARKET_ID);
    const account = loadArtifact('SmartAccount');
    expect(String(await read(at('SmartAccount'), account.abi, 'entryPoint')).toLowerCase()).toBe(ENTRYPOINT_V07.toLowerCase());
    const factory = loadArtifact('AccountFactory');
    expect(String(await read(at('AccountFactory'), factory.abi, 'implementation')).toLowerCase()).toBe(at('SmartAccount').toLowerCase());

    const venueCode = await suite.publicClient.getCode({ address: at('SovereignVenue'), blockNumber: deployed.venueBlock });
    expect(venueCode && venueCode.length > 2, 'venue has code at INDEXER_START_HEIGHT').toBe(true);
    const beforeVenue = await suite.publicClient.getCode({ address: at('SovereignVenue'), blockNumber: deployed.venueBlock - 1n });
    expect(beforeVenue ?? '0x', 'venue has no code the block before').toBe('0x');

    const lines = deployEnvLines(deployed, target);
    const settings = Object.fromEntries(lines.map((l) => l.split('=') as [string, string]));
    expect(settings).toEqual({
      PROTOCOL_CHAIN_ID: String(devChainMod.DEV_CHAIN_ID),
      PROTOCOL_RPC_URL: suite.rpcUrl,
      PROTOCOL_ENTRYPOINT_ADDRESS: ENTRYPOINT_V07,
      PROTOCOL_FACTORY_ADDRESS: at('AccountFactory'),
      PROTOCOL_IMPLEMENTATION_ADDRESS: at('SmartAccount'),
      PROTOCOL_AMM_FACTORY_ADDRESS: at('PoolFactory'),
      PROTOCOL_TOKEN_FACTORY_ADDRESS: at('TokenFactory'),
      PROTOCOL_VENUE_ADDRESS: at('SovereignVenue'),
      PROTOCOL_P2P_ESCROW_ADDRESS: at('SovereignEscrow'),
      INDEXER_CHAIN_ID: String(devChainMod.DEV_CHAIN_ID),
      INDEXER_RPC_URL: suite.rpcUrl,
      INDEXER_VENUE_ADDRESS: at('SovereignVenue'),
      INDEXER_START_HEIGHT: String(deployed.venueBlock),
    });
    expect(lines.join('\n')).not.toContain(target.deployerKey.slice(2));
  });

  it('refuses a public Anvil/Hardhat key before sending anything', async () => {
    const devKey = KNOWN_DEV_PRIVATE_KEYS[3] as Hex;
    const address = privateKeyToAccount(devKey).address;
    const nonce = await suite.publicClient.getTransactionCount({ address });
    await expect(deployProtocolSuite({ ...target, deployerKey: devKey })).rejects.toThrow(/public Anvil\/Hardhat key/);
    expect(await suite.publicClient.getTransactionCount({ address })).toBe(nonce);
  });

  it('refuses a node on another chain, a quote token that is not 6 decimals, and an unfunded key, sending nothing', async () => {
    const key = await freshFundedKey();
    const address = privateKeyToAccount(key).address;
    await expect(deployProtocolSuite({ ...target, deployerKey: key, chainId: 84532 })).rejects.toThrow(
      /the RPC reports chain 31337, not 84532/,
    );
    const eighteen = await deployToken(18);
    await expect(deployProtocolSuite({ ...target, deployerKey: key, usdc: eighteen })).rejects.toThrow(/USDC decimals\(\) is 18, want 6/);
    await expect(
      deployProtocolSuite({ ...target, deployerKey: key, usdc: privateKeyToAccount(generatePrivateKey()).address }),
    ).rejects.toThrow(/USDC has no code/);
    expect(await suite.publicClient.getTransactionCount({ address })).toBe(0);

    const empty = generatePrivateKey();
    await expect(deployProtocolSuite({ ...target, deployerKey: empty })).rejects.toThrow(/has no ETH/);
  });
});
