import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Account, Address, Hex } from 'viem';

/**
 * The only thing `EvmLiveChain` knows about signing. A provider (MPC, HSM,
 * enclave) implements this later by returning a viem custom account whose
 * `signTransaction` calls the provider; the key never enters this process or
 * its settings. No provider is bought yet (owner decision 2026-10-19), so the
 * one implementation here is `TestnetSigner`.
 */
export interface EvmSigner {
  /** Short label for the boot log, e.g. `testnet`. */
  readonly kind: string;
  readonly address: Address;
  /** Whether this signer may sign for the chain. A false answer refuses boot. */
  supportsChain(chainId: number): boolean;
  /** viem account that signs outbound transactions. */
  account(): Account;
}

/** Chains where a throwaway key is acceptable: local nodes and public testnets. */
export const TESTNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  31337, // anvil / hardhat
  1337, // local dev chains
  11155111, // Sepolia
  17000, // Holesky
  84532, // Base Sepolia
]);

export class SignerUnsetError extends Error {
  readonly code = 'pay.signer_unset';
  constructor(detail: string) {
    super(`pay.signer_unset: ${detail}`);
    this.name = 'SignerUnsetError';
  }
}

export class SignerChainRefusedError extends Error {
  readonly code = 'pay.signer_chain_refused';
  constructor(kind: string, chainId: number) {
    super(`pay.signer_chain_refused: the ${kind} signer does not sign for chain id ${chainId}`);
    this.name = 'SignerChainRefusedError';
  }
}

/**
 * Throwaway signer for local and public test chains. It refuses every other
 * chain id, so it cannot move mainnet value. `ephemeral()` makes a fresh key
 * held only in memory (a new address each boot); a test may pass its own
 * fixture key. Neither path reads a key from settings.
 */
export class TestnetSigner implements EvmSigner {
  readonly kind = 'testnet';
  private readonly signing: ReturnType<typeof privateKeyToAccount>;

  private constructor(key: Hex) {
    this.signing = privateKeyToAccount(key);
  }

  static ephemeral(): TestnetSigner {
    return new TestnetSigner(generatePrivateKey());
  }

  static fromFixtureKey(key: Hex): TestnetSigner {
    return new TestnetSigner(key);
  }

  get address(): Address {
    return this.signing.address;
  }

  supportsChain(chainId: number): boolean {
    return TESTNET_CHAIN_IDS.has(chainId);
  }

  account(): Account {
    return this.signing;
  }
}
