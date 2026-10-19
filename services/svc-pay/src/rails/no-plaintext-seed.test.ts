import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryBroadcastStore } from './broadcast-store.js';
import { TestnetSigner } from './evm-signer.js';
import { tryLiveChainFromEnv } from './posture.js';
import { DepositSourceUnsetError, TestnetDepositAddresses } from './deposit-source.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const ROOT = join(SRC, '..', '..', '..');
const read = (p: string): string => readFileSync(p, 'utf8');

// Public anvil dev phrase. A test fixture, never a real value.
const FIXTURE_PHRASE = 'test test test test test test test test test test test junk';

const LIVE_ENV = {
  APP_ENV: 'dev',
  PAY_CRYPTO_RPC_URL: 'http://127.0.0.1:8545',
  PAY_CRYPTO_CHAIN_ID: '31337',
  PAY_CRYPTO_SIGNER: 'testnet',
  PAY_CRYPTO_ASSETS: 'ETH:native',
  PAY_MIN_CONFIRMATIONS: '6',
};

describe('the plaintext deposit seed phrase path is gone', () => {
  it('env.ts no longer declares a seed phrase setting', () => {
    expect(read(join(SRC, 'env.ts'))).not.toMatch(/PAY_CRYPTO_DEPOSIT_MNEMONIC/);
  });

  it('the chain options take a deposit source, never a phrase', () => {
    const chain = read(join(HERE, 'evm-chain.ts'));
    expect(chain).not.toMatch(/depositMnemonic/);
    expect(chain).not.toMatch(/mnemonicToAccount/);
  });

  it('posture.ts never reads a seed phrase from the environment', () => {
    expect(read(join(HERE, 'posture.ts'))).not.toMatch(/PAY_CRYPTO_DEPOSIT_MNEMONIC/);
  });

  it('compose no longer forwards a seed phrase to svc-pay', () => {
    expect(read(join(ROOT, 'docker-compose.apps.yml'))).not.toMatch(/PAY_CRYPTO_DEPOSIT_MNEMONIC/);
  });

  it('a phrase left in the environment is ignored: with no source chosen the live rail refuses', () => {
    expect(() => tryLiveChainFromEnv({ ...LIVE_ENV, PAY_CRYPTO_DEPOSIT_MNEMONIC: FIXTURE_PHRASE }, new MemoryBroadcastStore())).toThrow(
      /pay\.deposit_source_unset/,
    );
  });

  it('PAY_CRYPTO_DEPOSIT_SOURCE=testnet boots the live rail on a test chain', () => {
    expect(tryLiveChainFromEnv({ ...LIVE_ENV, PAY_CRYPTO_DEPOSIT_SOURCE: 'testnet' }, new MemoryBroadcastStore())).not.toBeNull();
  });

  it('an unknown source name refuses', () => {
    expect(() => tryLiveChainFromEnv({ ...LIVE_ENV, PAY_CRYPTO_DEPOSIT_SOURCE: 'hsm' }, new MemoryBroadcastStore())).toThrow(
      /pay\.deposit_source_unset/,
    );
  });

  it('the testnet source is refused in staging and prod', () => {
    for (const appEnv of ['staging', 'prod']) {
      expect(() =>
        tryLiveChainFromEnv(
          { ...LIVE_ENV, APP_ENV: appEnv, PAY_CRYPTO_DEPOSIT_SOURCE: 'testnet' },
          new MemoryBroadcastStore(),
          TestnetSigner.ephemeral(),
        ),
      ).toThrow(/pay\.deposit_source_unset/);
    }
  });

  it('the testnet source does not serve a mainnet chain id', () => {
    const source = TestnetDepositAddresses.fromFixturePhrase(FIXTURE_PHRASE);
    expect(source.supportsChain(31337)).toBe(true);
    expect(source.supportsChain(1)).toBe(false);
    expect(source.supportsChain(8453)).toBe(false);
  });

  it('the same payment gets the same address, and different payments differ', () => {
    const source = TestnetDepositAddresses.fromFixturePhrase(FIXTURE_PHRASE);
    expect(source.addressFor('pay_1', 'ETH')).toBe(source.addressFor('pay_1', 'ETH'));
    expect(source.addressFor('pay_1', 'ETH')).not.toBe(source.addressFor('pay_2', 'ETH'));
  });

  it('the typed error carries its code', () => {
    expect(new DepositSourceUnsetError('x').code).toBe('pay.deposit_source_unset');
  });
});
