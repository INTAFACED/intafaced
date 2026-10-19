import { keccak256, toBytes } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { TESTNET_CHAIN_IDS } from './evm-signer.js';

/**
 * The only thing `EvmLiveChain` knows about where deposit addresses come from.
 * A provider (HSM, MPC wallet, xpub service) implements this later; the seed
 * phrase then never enters this process or its settings. No provider is bought
 * yet (owner decision 2026-10-19), so the one implementation here is
 * `TestnetDepositAddresses`.
 */
export interface DepositAddressSource {
  /** Short label for the boot log, e.g. `testnet`. */
  readonly kind: string;
  /** Whether this source may hand out addresses for the chain. A false answer refuses boot. */
  supportsChain(chainId: number): boolean;
  /** Pure function of the payment: a restart or another replica gives the same address. */
  addressFor(paymentId: string, assetId: string): Address;
}

export class DepositSourceUnsetError extends Error {
  readonly code = 'pay.deposit_source_unset';
  constructor(detail: string) {
    super(`pay.deposit_source_unset: ${detail}`);
    this.name = 'DepositSourceUnsetError';
  }
}

export class DepositSourceChainRefusedError extends Error {
  readonly code = 'pay.deposit_source_chain_refused';
  constructor(kind: string, chainId: number) {
    super(`pay.deposit_source_chain_refused: the ${kind} deposit source does not serve chain id ${chainId}`);
    this.name = 'DepositSourceChainRefusedError';
  }
}

/** Public anvil dev phrase. Funds sent to these addresses on a live chain are lost; test chains only. */
const PUBLIC_TEST_PHRASE = 'test test test test test test test test test test test junk';

/**
 * Deposit addresses for local and public test chains. It refuses every other
 * chain id. Addresses are HD-derived at `m/44'/60'/0'/<high>/<low>` from a
 * public throwaway phrase held in code, so they are stable across restarts;
 * no setting carries a phrase.
 */
export class TestnetDepositAddresses implements DepositAddressSource {
  readonly kind = 'testnet';

  private constructor(private readonly phrase: string) {
    mnemonicToAccount(phrase);
  }

  static default(): TestnetDepositAddresses {
    return new TestnetDepositAddresses(PUBLIC_TEST_PHRASE);
  }

  static fromFixturePhrase(phrase: string): TestnetDepositAddresses {
    return new TestnetDepositAddresses(phrase);
  }

  supportsChain(chainId: number): boolean {
    return TESTNET_CHAIN_IDS.has(chainId);
  }

  /**
   * Two 31-bit path levels from one keccak digest (62 bits), so two payments
   * sharing an address is about 2^-62 per pair rather than 2^-31.
   */
  addressFor(paymentId: string, assetId: string): Address {
    const digest = BigInt(keccak256(toBytes(`${paymentId}:${assetId}`)));
    const high = Number((digest >> 31n) & 0x7fff_ffffn);
    const low = Number(digest & 0x7fff_ffffn);
    return mnemonicToAccount(this.phrase, { path: `m/44'/60'/0'/${high}/${low}` }).address;
  }
}
