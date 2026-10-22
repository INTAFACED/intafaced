/**
 * RC-identity-16 — portable identity: unsigned builders and a verifier read for RankAttestation.
 *
 * Self-issued only: the holder's own wallet signs `attest`/`revoke`; this service holds no key and
 * submits nothing (there is no platform issuer, see RankAttestation.sol). The commitment is
 * keccak256 of a holder-chosen salt (`subjectCommitment`); the salt is never stored or returned.
 */
import { encodeFunctionData, isAddress, isHex, type Address, type Hex } from 'viem';
import { subjectCommitment } from './commitment.js';

export type AttestationRefusalCode =
  'protocol.attestation_registry_unset' | 'protocol.attestation_pii_field' | 'protocol.attestation_input' | 'audit.external';

export class AttestationRefusedError extends Error {
  constructor(
    readonly code: AttestationRefusalCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AttestationRefusedError';
  }
}

/**
 * Chains the unaudited registry may be built for. Anything else (every mainnet, INTACHAIN included)
 * refuses `audit.external`: an allow-list, so an unknown chain fails closed.
 */
export const ATTESTATION_TESTNET_CHAINS: ReadonlyMap<number, string> = new Map([
  [84532, 'Base Sepolia testnet. Not INTACHAIN. audited:false'],
  [11155111, 'Sepolia testnet. Not INTACHAIN. audited:false'],
  [31337, 'Local Anvil chain. Not INTACHAIN. audited:false'],
]);

export const rankAttestationAbi = [
  {
    type: 'function',
    name: 'attest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'commitment', type: 'bytes32' },
      { name: 'rank', type: 'uint64' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'schemaId', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Revoked',
    inputs: [
      { name: 'commitment', type: 'bytes32', indexed: true },
      { name: 'issuer', type: 'address', indexed: true },
    ],
  },
  { type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [{ name: 'commitment', type: 'bytes32' }], outputs: [] },
  {
    type: 'function',
    name: 'attestations',
    stateMutability: 'view',
    inputs: [
      { name: 'commitment', type: 'bytes32' },
      { name: 'issuer', type: 'address' },
    ],
    outputs: [
      { name: 'rank', type: 'uint64' },
      { name: 'issuedAt', type: 'uint64' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'schemaId', type: 'bytes32' },
    ],
  },
] as const;

/** The only fields an attestation payload may carry. Anything else is refused as a possible PII leak. */
export const ATTESTATION_PAYLOAD_FIELDS = ['schemaId', 'rank', 'expiresAt', 'commitment'] as const;
export type AttestationPayload = { schemaId: Hex; rank: string; expiresAt: string; commitment: Hex };

export type AttestationConfig = { registry: string | undefined; chainId: number };
export type UnsignedAttestationCall = { to: Address; data: Hex; value: '0'; chainId: number; label: string };

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const UINT64_MAX = (1n << 64n) - 1n;
/** RankAttestation.MAX_RANK; a larger rank would revert on chain, so it is refused before building. */
export const MAX_RANK = 1_000_000n;
const ZERO = '0x0000000000000000000000000000000000000000';

function registryOf(config: AttestationConfig): { to: Address; label: string } {
  const label = ATTESTATION_TESTNET_CHAINS.get(config.chainId);
  if (label === undefined) {
    throw new AttestationRefusedError('audit.external', `chain ${config.chainId} needs an external audit before attestations are built`);
  }
  const reg = config.registry?.trim();
  if (!reg || !isAddress(reg) || reg.toLowerCase() === ZERO) {
    throw new AttestationRefusedError('protocol.attestation_registry_unset', 'PROTOCOL_RANK_ATTESTATION_ADDRESS is unset');
  }
  return { to: reg as Address, label };
}

function uint64(name: string, value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) {
    throw new AttestationRefusedError('protocol.attestation_input', `${name} must be a decimal integer string`);
  }
  const n = BigInt(value);
  if (n > UINT64_MAX) throw new AttestationRefusedError('protocol.attestation_input', `${name} is out of range`);
  return n;
}

function bytes32(name: string, value: unknown): Hex {
  if (typeof value !== 'string' || !BYTES32.test(value)) {
    throw new AttestationRefusedError('protocol.attestation_input', `${name} must be 32 bytes of hex`);
  }
  return value.toLowerCase() as Hex;
}

/** Refuses any key outside the four allowed payload fields (user id, email, name, address, ...). */
export function assertZeroPiiPayload(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (!(ATTESTATION_PAYLOAD_FIELDS as readonly string[]).includes(key)) {
      throw new AttestationRefusedError('protocol.attestation_pii_field', `field "${key}" is not allowed in an attestation payload`);
    }
  }
}

export function buildAttest(
  config: AttestationConfig,
  input: Record<string, unknown>,
): { call: UnsignedAttestationCall; payload: AttestationPayload } {
  const allowed = new Set(['schemaId', 'rank', 'expiresAt', 'salt']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new AttestationRefusedError('protocol.attestation_pii_field', `field "${key}" is not allowed in an attestation request`);
    }
  }
  const { to, label } = registryOf(config);
  const schemaId = bytes32('schemaId', input.schemaId);
  const rank = uint64('rank', input.rank);
  if (rank > MAX_RANK) throw new AttestationRefusedError('protocol.attestation_input', 'rank is above the registry maximum');
  const expiresAt = uint64('expiresAt', input.expiresAt);
  if (typeof input.salt !== 'string' || !isHex(input.salt) || input.salt.length < 66) {
    throw new AttestationRefusedError('protocol.attestation_input', 'salt must be at least 32 bytes of hex');
  }
  const commitment = subjectCommitment(input.salt as Hex);
  const payload: AttestationPayload = { schemaId, rank: rank.toString(), expiresAt: expiresAt.toString(), commitment };
  assertZeroPiiPayload(payload);
  const data = encodeFunctionData({ abi: rankAttestationAbi, functionName: 'attest', args: [commitment, rank, expiresAt, schemaId] });
  return { call: { to, data, value: '0', chainId: config.chainId, label }, payload };
}

export function buildRevoke(config: AttestationConfig, input: { commitment: unknown }): UnsignedAttestationCall {
  const { to, label } = registryOf(config);
  const commitment = bytes32('commitment', input.commitment);
  const data = encodeFunctionData({ abi: rankAttestationAbi, functionName: 'revoke', args: [commitment] });
  return { to, data, value: '0', chainId: config.chainId, label };
}

export type AttestationRecord = readonly [rank: bigint, issuedAt: bigint, expiresAt: bigint, schemaId: Hex];
export type AttestationReader = (args: { address: Address; commitment: Hex; issuer: Address }) => Promise<AttestationRecord>;
/** True when a `Revoked(commitment, issuer)` log exists on the registry. A failed log read throws. */
export type RevocationReader = (args: { address: Address; commitment: Hex; issuer: Address }) => Promise<boolean>;
export type AttestationStatus =
  { status: 'none' | 'revoked' } | { status: 'live' | 'expired'; rank: string; issuedAt: string; expiresAt: string; schemaId: Hex };

/**
 * Reads `attestations(commitment, issuer)`. Zero `issuedAt` means no live record: the contract deletes a
 * revoked record, so the `Revoked(commitment, issuer)` log tells "revoked" from "none" (never issued).
 * A failed record or log read propagates; it is never reported as "none".
 */
export async function verifyAttestation(
  config: AttestationConfig,
  input: { commitment: unknown; issuer: unknown },
  read: AttestationReader,
  readRevoked: RevocationReader,
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<AttestationStatus> {
  const { to } = registryOf(config);
  const commitment = bytes32('commitment', input.commitment);
  if (typeof input.issuer !== 'string' || !isAddress(input.issuer)) {
    throw new AttestationRefusedError('protocol.attestation_input', 'issuer must be an address');
  }
  const args = { address: to, commitment, issuer: input.issuer as Address };
  const [rank, issuedAt, expiresAt, schemaId] = await read(args);
  if (issuedAt === 0n) return { status: (await readRevoked(args)) ? 'revoked' : 'none' };
  return {
    status: expiresAt !== 0n && expiresAt <= nowSeconds ? 'expired' : 'live',
    rank: rank.toString(),
    issuedAt: issuedAt.toString(),
    expiresAt: expiresAt.toString(),
    schemaId,
  };
}
