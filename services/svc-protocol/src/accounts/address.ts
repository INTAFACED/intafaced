import { encodeAbiParameters, getContractAddress, isAddress, keccak256, getAddress as toChecksum } from 'viem';
import type { Address, Hex } from 'viem';
import { PROTOCOL_DEFAULT_USER_SALT } from '@intafaced/contracts/protocol-procedures';

/**
 * DETERMINISTIC ADDRESS DERIVATION (§17.4).
 *
 * A user is shown their smart account address during onboarding, before any
 * transaction exists and before anyone has paid for a deployment. This file is
 * what makes that promise true off-chain, and it must agree with
 * `AccountFactory.getAddress` byte for byte — if it does not, we show a user an
 * address, they fund it, and the funds sit at a contract that never appears.
 *
 * The account is an EIP-1167 minimal proxy, so the creation code is fully
 * determined by the implementation address. No compiler output is needed to
 * derive an address, which is the reason the account is a clone rather than an
 * ERC-1967 proxy — and, more importantly, the reason it can never be upgraded.
 */

/** `3d602d80600a3d3981f3` (constructor) ++ `363d3d373d3d3d363d73` (runtime head). */
export const MINIMAL_PROXY_PREFIX = '0x3d602d80600a3d3981f3363d3d373d3d3d363d73' as const;
/** Runtime tail after the 20-byte implementation address. */
export const MINIMAL_PROXY_SUFFIX = '5af43d82803e903d91602b57fd5bf3' as const;
/** 10 + 10 + 20 + 15. The EVM sees 0x37 bytes; so does `_cloneDeterministic`. */
export const MINIMAL_PROXY_LENGTH_BYTES = 55;

/** Default user salt — one account per owner unless the user asks for more. */
export const DEFAULT_USER_SALT: Hex = PROTOCOL_DEFAULT_USER_SALT;

export class AddressDerivationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AddressDerivationError';
  }
}

function requireAddress(value: string, field: string): Address {
  if (!isAddress(value, { strict: false })) {
    throw new AddressDerivationError(`${field} is not an address: ${value}`, 'protocol.invalid_address');
  }
  return toChecksum(value);
}

/** The exact creation code CREATE2 will hash. */
export function minimalProxyInitCode(implementation: Address): Hex {
  const impl = requireAddress(implementation, 'implementation').slice(2).toLowerCase();
  return `${MINIMAL_PROXY_PREFIX}${impl}${MINIMAL_PROXY_SUFFIX}` as Hex;
}

/**
 * `keccak256(abi.encode(owner, userSalt))`.
 *
 * The owner is bound into the salt on purpose: it is what stops a relayer, or
 * anyone else, from deploying an account they control at an address a user has
 * already been shown and funded.
 */
export function accountSalt(owner: Address, userSalt: Hex = DEFAULT_USER_SALT): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [requireAddress(owner, 'owner'), userSalt]));
}

export interface AccountAddressInput {
  /** The deployed AccountFactory. */
  factory: Address;
  /** The SmartAccount implementation every clone delegates to. */
  implementation: Address;
  /** The user's key — an EOA, or a P-256 verifier contract for a passkey. */
  owner: Address;
  /** Lets one owner hold several accounts (named spaces, §23). */
  userSalt?: Hex;
}

/**
 * The address, before the account exists.
 *
 * `keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]` — the CREATE2
 * rule, applied to the minimal proxy's creation code.
 */
export function computeAccountAddress(input: AccountAddressInput): Address {
  const factory = requireAddress(input.factory, 'factory');
  const implementation = requireAddress(input.implementation, 'implementation');
  const owner = requireAddress(input.owner, 'owner');
  const userSalt = input.userSalt ?? DEFAULT_USER_SALT;

  if (!/^0x[0-9a-fA-F]{64}$/.test(userSalt)) {
    throw new AddressDerivationError(`userSalt must be 32 bytes: ${userSalt}`, 'protocol.invalid_salt');
  }

  return getContractAddress({
    opcode: 'CREATE2',
    from: factory,
    salt: accountSalt(owner, userSalt),
    bytecode: minimalProxyInitCode(implementation),
  });
}
