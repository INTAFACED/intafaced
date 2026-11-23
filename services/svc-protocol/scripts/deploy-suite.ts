/**
 * The Protocol suite's deploy, written once for every chain it goes to.
 *
 * `deploy-sepolia.ts` is the CLI: it reads its env (`sepolia-deploy-env.ts`, which holds it to Base Sepolia,
 * Circle USDC and the canonical EntryPoint), calls `deployProtocolSuite`, writes the registry and prints
 * `deployEnvLines`. The on-chain test calls the same function against the local dev chain, so the code a public test
 * chain runs is the code CI runs.
 *
 * Refuses, before any transaction: a well-known Anvil / Hardhat key (whoever holds the public key owns what it
 * deploys), a node whose chain id is not the target's, a quote token with no code or not 6 decimals, and an empty
 * deployer balance. Never logs the key.
 */
import { createPublicClient, createWalletClient, defineChain, http, isAddress, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadArtifact, type ArtifactName } from '../src/chain/artifacts.js';
import type { DeploymentRegistry } from '../src/deployments/registry.js';
import { assertNotDevKey } from './sepolia-deploy-env.js';

/** The venue's one market: TEST base against the chain's USDC. `svc-indexer` aliases this hash to `TEST/USDC`. */
export const SUITE_MARKET_ID = keccak256(stringToHex('TEST/USDC'));

export type DeployTarget = {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  deployerKey: Hex;
  entryPoint: Address;
  /** The venue's quote token: Circle USDC on a public test chain, a 6-decimal TEST token on a local one. */
  usdc: Address;
  /** Explorer address page prefix, e.g. `https://sepolia.basescan.org/address/`. Omitted on a local chain. */
  explorerAddressUrl?: string;
  rpcNote: string;
};

export type DeployedSuite = {
  registry: DeploymentRegistry;
  /** Block the venue was deployed in: the indexer starts reading there. */
  venueBlock: bigint;
};

class DeployRefusedError extends Error {
  constructor(message: string) {
    super(`deploy refused: ${message}`);
    this.name = 'DeployRefusedError';
  }
}

const DECIMALS_ABI = [{ name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const;

export async function deployProtocolSuite(target: DeployTarget): Promise<DeployedSuite> {
  assertNotDevKey(target.deployerKey);
  const account = privateKeyToAccount(target.deployerKey);
  const chain = defineChain({
    id: target.chainId,
    name: target.chainName,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [target.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(target.rpcUrl) });
  const wallet = createWalletClient({ chain, transport: http(target.rpcUrl), account });

  const reported = await publicClient.getChainId();
  if (reported !== target.chainId) {
    throw new DeployRefusedError(`the RPC reports chain ${reported}, not ${target.chainId} (${target.chainName})`);
  }
  const usdcCode = await publicClient.getCode({ address: target.usdc });
  if (!usdcCode || usdcCode === '0x') throw new DeployRefusedError('USDC has no code on this RPC');
  const usdcDec = await publicClient.readContract({ address: target.usdc, abi: DECIMALS_ABI, functionName: 'decimals' });
  if (usdcDec !== 6) throw new DeployRefusedError(`USDC decimals() is ${usdcDec}, want 6`);
  const bal = await publicClient.getBalance({ address: account.address });
  if (bal === 0n) throw new DeployRefusedError(`deployer ${account.address} has no ETH on ${target.chainName}: use a faucet`);

  const contracts: DeploymentRegistry['contracts'] = [];
  let venueBlock = 0n;

  const deploy = async (rowName: string, artifact: ArtifactName, args: readonly unknown[] = []): Promise<Address> => {
    const art = loadArtifact(artifact);
    const hash = await wallet.deployContract({
      abi: art.abi,
      bytecode: art.bytecode,
      args,
      account,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) {
      throw new Error(`${artifact} deploy failed ${hash}`);
    }
    const address = receipt.contractAddress;
    contracts.push({
      name: rowName,
      address,
      sourceHash: art.sourceHash,
      suite: art.suite,
      ...(target.explorerAddressUrl ? { explorerUrl: `${target.explorerAddressUrl}${address}` } : {}),
      verified: false,
    });
    if (artifact === 'SovereignVenue') venueBlock = receipt.blockNumber;
    return address;
  };

  const testToken = await deploy('TEST', 'MockERC20');
  const implementation = await deploy('SmartAccount', 'SmartAccount', [target.entryPoint]);
  await deploy('AccountFactory', 'AccountFactory', [implementation]);
  await deploy('TokenFactory', 'TokenFactory');
  await deploy('PoolFactory', 'PoolFactory');
  await deploy('SovereignVenue', 'SovereignVenue', [
    SUITE_MARKET_ID,
    testToken,
    target.usdc,
    0,
    '0x0000000000000000000000000000000000000000',
  ]);
  await deploy('ScopedPaymaster', 'ScopedPaymaster', [target.entryPoint, account.address]);
  await deploy('SovereignEscrow', 'SovereignEscrow');

  return {
    registry: {
      chainId: target.chainId,
      chainName: target.chainName,
      rpcNote: target.rpcNote,
      deployedAt: new Date().toISOString(),
      contracts,
    },
    venueBlock,
  };
}

/**
 * Each registry row a service reads, and the setting it goes in. `SovereignVenue` feeds both the service (wallets
 * deposit into it) and the indexer (its logs are the book). The TEST token and the paymaster have no setting.
 */
const ENV_FOR_ROW: readonly (readonly [row: string, key: string])[] = [
  ['AccountFactory', 'PROTOCOL_FACTORY_ADDRESS'],
  ['SmartAccount', 'PROTOCOL_IMPLEMENTATION_ADDRESS'],
  ['PoolFactory', 'PROTOCOL_AMM_FACTORY_ADDRESS'],
  ['TokenFactory', 'PROTOCOL_TOKEN_FACTORY_ADDRESS'],
  ['SovereignVenue', 'PROTOCOL_VENUE_ADDRESS'],
  ['SovereignEscrow', 'PROTOCOL_P2P_ESCROW_ADDRESS'],
  ['SovereignVenue', 'INDEXER_VENUE_ADDRESS'],
];

/**
 * The `KEY=value` lines svc-protocol and svc-indexer need to run on what was just deployed. Both read the same chain
 * through the same RPC. Holds no secret: the deployer key is never part of it.
 */
export function deployEnvLines(deployed: DeployedSuite, target: Pick<DeployTarget, 'rpcUrl' | 'entryPoint'>): string[] {
  const { registry, venueBlock } = deployed;
  const at = (row: string): Address => {
    const found = registry.contracts.find((c) => c.name === row);
    if (!found || !isAddress(found.address)) throw new Error(`registry has no ${row} address`);
    return found.address;
  };
  return [
    `PROTOCOL_CHAIN_ID=${registry.chainId}`,
    `PROTOCOL_RPC_URL=${target.rpcUrl}`,
    `PROTOCOL_ENTRYPOINT_ADDRESS=${target.entryPoint}`,
    ...ENV_FOR_ROW.filter(([, key]) => key.startsWith('PROTOCOL_')).map(([row, key]) => `${key}=${at(row)}`),
    `INDEXER_CHAIN_ID=${registry.chainId}`,
    `INDEXER_RPC_URL=${target.rpcUrl}`,
    ...ENV_FOR_ROW.filter(([, key]) => key.startsWith('INDEXER_')).map(([row, key]) => `${key}=${at(row)}`),
    `INDEXER_START_HEIGHT=${venueBlock}`,
  ];
}
