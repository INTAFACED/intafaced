/**
 * Deploy the Protocol suite to Base Sepolia (84532) and print the settings svc-protocol and svc-indexer need.
 *
 *   PROTOCOL_CHAIN_ID=84532 \
 *   PROTOCOL_RPC_URL=https://sepolia.base.org \
 *   PROTOCOL_DEPLOYER_KEY=0x… \
 *   PROTOCOL_ENTRYPOINT_ADDRESS=0x0000000071727De22E5E9d8BAf0edAc6f37da032 \
 *   PROTOCOL_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
 *   pnpm --filter @intafaced/svc-protocol chain:deploy-sepolia
 *
 * The key must be a fresh one funded from a faucet: a public Anvil/Hardhat key is refused. The RPC must be http(s):
 * svc-indexer reads it over HTTP. Writes deployments/base-sepolia.json, then prints `KEY=value` lines for
 * PROTOCOL_* and INDEXER_* on stdout. Never prints or writes the key. The deploy itself is
 * `src/deployments/deploy-suite.ts`, which the on-chain test runs against the local dev chain.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployEnvLines, deployProtocolSuite, type DeployedSuite, type DeployTarget } from '../src/deployments/deploy-suite.js';
import { assertSepoliaRegistry } from '../src/deployments/registry.js';
import { parseSepoliaDeployEnv, SEPOLIA_CHAIN_ID } from './sepolia-deploy-env.js';

export function sepoliaTarget(env: NodeJS.ProcessEnv = process.env): DeployTarget {
  const cfg = parseSepoliaDeployEnv(env);
  return {
    chainId: SEPOLIA_CHAIN_ID,
    chainName: 'base-sepolia',
    rpcUrl: cfg.rpcUrl,
    deployerKey: cfg.deployerKey,
    entryPoint: cfg.entryPoint,
    usdc: cfg.usdc,
    explorerAddressUrl: 'https://sepolia.basescan.org/address/',
    rpcNote: 'Base Sepolia testnet. Not INTACHAIN. audited:false.',
  };
}

export async function deploySepoliaSuite(env: NodeJS.ProcessEnv = process.env): Promise<{ deployed: DeployedSuite; target: DeployTarget }> {
  const target = sepoliaTarget(env);
  const deployed = await deployProtocolSuite(target);
  assertSepoliaRegistry(deployed.registry);
  return { deployed, target };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { deployed, target } = await deploySepoliaSuite();
  const out = join(dirname(fileURLToPath(import.meta.url)), '../deployments/base-sepolia.json');
  writeFileSync(out, `${JSON.stringify(deployed.registry, null, 2)}\n`);
  console.error(`wrote ${out}`);
  for (const c of deployed.registry.contracts) console.error(`${c.name} ${c.address}`);
  console.error('settings for svc-protocol and svc-indexer:');
  console.log(deployEnvLines(deployed, target).join('\n'));
}
