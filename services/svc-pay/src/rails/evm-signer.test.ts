import { describe, expect, it } from 'vitest';
import { TestnetDepositAddresses } from './deposit-source.js';
import { MemoryBroadcastStore } from './broadcast-store.js';
import { parseEvmAssets } from './evm-assets.js';
import { EvmLiveChain } from './evm-chain.js';
import { TestnetSigner } from './evm-signer.js';
import { tryLiveChainFromEnv } from './posture.js';

const ENV = {
  PAY_CRYPTO_RPC_URL: 'http://127.0.0.1:8545',
  PAY_CRYPTO_CHAIN_ID: '31337',
  PAY_CRYPTO_DEPOSIT_SOURCE: 'testnet',
  PAY_CRYPTO_ASSETS: 'ETH:native',
  PAY_MIN_CONFIRMATIONS: '6',
};

describe('TestnetSigner', () => {
  it('makes a fresh in-memory key each time', () => {
    expect(TestnetSigner.ephemeral().address).not.toBe(TestnetSigner.ephemeral().address);
  });

  it('signs only for test chains', () => {
    const signer = TestnetSigner.ephemeral();
    expect(signer.supportsChain(31337)).toBe(true);
    expect(signer.supportsChain(11155111)).toBe(true);
    expect(signer.supportsChain(1)).toBe(false);
    expect(signer.supportsChain(8453)).toBe(false);
  });

  it('EvmLiveChain refuses to boot a testnet signer on a mainnet chain id', () => {
    expect(
      () =>
        new EvmLiveChain({
          rpcUrl: 'http://127.0.0.1:9',
          chainId: 1,
          deposits: TestnetDepositAddresses.default(),
          signer: TestnetSigner.ephemeral(),
          assets: parseEvmAssets('ETH:native'),
          broadcasts: new MemoryBroadcastStore(),
          minConfirmations: 1,
        }),
    ).toThrow(/pay\.signer_chain_refused/);
  });
});

describe('signer choice from settings', () => {
  it('refuses when no signer is chosen', () => {
    expect(() => tryLiveChainFromEnv({ APP_ENV: 'dev', ...ENV })).toThrow(/pay\.signer_unset/);
  });

  it('refuses an unknown signer name', () => {
    expect(() => tryLiveChainFromEnv({ APP_ENV: 'dev', ...ENV, PAY_CRYPTO_SIGNER: 'hsm' })).toThrow(/pay\.signer_unset/);
  });

  it('refuses the testnet signer in staging and prod', () => {
    for (const APP_ENV of ['staging', 'prod']) {
      expect(() => tryLiveChainFromEnv({ APP_ENV, ...ENV, PAY_CRYPTO_SIGNER: 'testnet' }, new MemoryBroadcastStore())).toThrow(
        /pay\.signer_unset.*refused in/,
      );
    }
  });

  it('accepts an injected provider signer in prod', () => {
    const signer = TestnetSigner.ephemeral();
    const chain = tryLiveChainFromEnv({ APP_ENV: 'prod', ...ENV }, new MemoryBroadcastStore(), signer, TestnetDepositAddresses.default());
    expect(chain!.hotWalletAddress()).toBe(signer.address);
  });
});
