/**
 * Sepolia deploy env — hermetic. The CLI (`scripts/deploy-sepolia.ts`) broadcasts;
 * this module only parses and refuses. Never logs the key.
 */
import { getContractAddress, isAddress, type Address, type Hex } from 'viem';

export const SEPOLIA_CHAIN_ID = 84532;
export const CIRCLE_USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
export const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;
export const BANNED_LIVE_CHAIN_IDS = [5042, 31337, 8453] as const;

export type SepoliaDeployEnv = {
  chainId: typeof SEPOLIA_CHAIN_ID;
  rpcUrl: string;
  deployerKey: Hex;
  entryPoint: Address;
  usdc: Address;
};

function requireNonEmpty(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v.trim() === '') {
    throw new Error(`${key} is unset`);
  }
  return v.trim();
}

export function parseSepoliaDeployEnv(env: NodeJS.ProcessEnv = process.env): SepoliaDeployEnv {
  const chainRaw = requireNonEmpty(env, 'PROTOCOL_CHAIN_ID');
  const chainId = Number(chainRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`PROTOCOL_CHAIN_ID must be a positive integer, got ${chainRaw}`);
  }
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `PROTOCOL_CHAIN_ID must be ${SEPOLIA_CHAIN_ID} (Base Sepolia). Refusing ${chainId}` +
        (BANNED_LIVE_CHAIN_IDS.includes(chainId as (typeof BANNED_LIVE_CHAIN_IDS)[number])
          ? ' (Arc/anvil/Base-mainnet are not this deploy).'
          : '.'),
    );
  }

  const rpcUrl = requireNonEmpty(env, 'PROTOCOL_RPC_URL');
  try {
    new URL(rpcUrl); // parsed only to refuse a malformed address
  } catch {
    throw new Error('PROTOCOL_RPC_URL must be a URL');
  }

  const keyRaw = requireNonEmpty(env, 'PROTOCOL_DEPLOYER_KEY');
  const deployerKey = (keyRaw.startsWith('0x') ? keyRaw : `0x${keyRaw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) {
    throw new Error('PROTOCOL_DEPLOYER_KEY must be a 32-byte hex key');
  }

  const entryPoint = requireNonEmpty(env, 'PROTOCOL_ENTRYPOINT_ADDRESS') as Address;
  if (!isAddress(entryPoint, { strict: true })) {
    throw new Error('PROTOCOL_ENTRYPOINT_ADDRESS must be a 20-byte hex address');
  }
  if (entryPoint.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) {
    throw new Error(`PROTOCOL_ENTRYPOINT_ADDRESS must be canonical v0.7 ${ENTRYPOINT_V07}`);
  }

  const usdc = requireNonEmpty(env, 'PROTOCOL_USDC_ADDRESS') as Address;
  if (!isAddress(usdc, { strict: true })) {
    throw new Error('PROTOCOL_USDC_ADDRESS must be a 20-byte hex address');
  }
  if (usdc.toLowerCase() !== CIRCLE_USDC_BASE_SEPOLIA.toLowerCase()) {
    throw new Error(`PROTOCOL_USDC_ADDRESS must be Circle native USDC ${CIRCLE_USDC_BASE_SEPOLIA} (refuse USDbC / IFC)`);
  }

  return { chainId: SEPOLIA_CHAIN_ID, rpcUrl, deployerKey, entryPoint, usdc };
}

/**
 * CREATE address of a contract deployed after one other tx from `from`
 * (the LaunchVesting pattern: approve the yet-to-exist spender, then deploy).
 * Using `currentNonce` without +1 targets the approve itself.
 */
export function createAddressAfterOneTx(from: Address, currentNonce: bigint | number): Address {
  return getContractAddress({ from, nonce: BigInt(currentNonce) + 1n });
}

/** Skip-if-named: existing registry row address, or undefined. */
export function namedAddress(contracts: readonly { name: string; address: string }[], name: string): Address | undefined {
  const row = contracts.find((c) => c.name === name);
  return row ? (row.address as Address) : undefined;
}
