import { getAddress, type Address } from 'viem';
import type { NetworkEntry, ProtocolDeploymentsOutput } from '@intafaced/contracts';
import { deploymentsFor, loadNetworkRegistry } from '../networks/registry.js';

/**
 * RC-p2p-01: where the escrow builders may point. The address is read from the
 * deployments registry for the configured chain, never passed in and never a
 * literal, so a builder can only target the recorded `SovereignEscrow`.
 *
 * Only a chain the owner's network registry records as a test or local network
 * is served. Any other chain (a mainnet, or a chain nobody recorded) refuses
 * `audit.external`: the contract is internally tested only, and a live network
 * waits for the external audit. Every answer carries `audited: false`.
 */

export type EscrowTargetErrorCode = 'protocol.escrow_not_deployed' | 'audit.external';

export class EscrowTargetError extends Error {
  constructor(
    readonly code: EscrowTargetErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'EscrowTargetError';
  }
}

export interface EscrowTarget {
  chainId: number;
  /** Base Sepolia reads "Base Sepolia testnet, not INTACHAIN". */
  chainLabel: string;
  escrow: Address;
  audited: false;
}

const SERVED_KINDS: ReadonlySet<string> = new Set(['testnet', 'local']);

export function resolveEscrowTarget(
  chainId: number,
  sources: { networks?: NetworkEntry[]; deployments?: ProtocolDeploymentsOutput | null } = {},
): EscrowTarget {
  const network = (sources.networks ?? loadNetworkRegistry()).find((n) => n.chainId === chainId);
  if (!network || !SERVED_KINDS.has(network.kind)) {
    throw new EscrowTargetError(
      'audit.external',
      `chain ${chainId} is not a recorded test network. SovereignEscrow is internally tested only; a live network waits for the external audit.`,
    );
  }
  const deployments = sources.deployments !== undefined ? sources.deployments : deploymentsFor(chainId);
  const entry = deployments?.contracts.find((c) => c.name === 'SovereignEscrow');
  if (!entry) {
    throw new EscrowTargetError('protocol.escrow_not_deployed', `SovereignEscrow is not in the deployments registry for chain ${chainId} (${network.name}).`);
  }
  return {
    chainId,
    chainLabel: chainId === 84532 ? 'Base Sepolia testnet, not INTACHAIN' : `${network.name}, not INTACHAIN`,
    escrow: getAddress(entry.address),
    audited: false,
  };
}
