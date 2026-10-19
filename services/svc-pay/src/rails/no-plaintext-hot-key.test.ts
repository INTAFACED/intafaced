import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryBroadcastStore } from './broadcast-store.js';
import { tryLiveChainFromEnv } from './posture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const ROOT = join(SRC, '..', '..', '..');
const read = (p: string): string => readFileSync(p, 'utf8');

// Test-only fixture key (public anvil dev account). Never a real value.
const FIXTURE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const LIVE_ENV = {
  APP_ENV: 'dev',
  PAY_CRYPTO_RPC_URL: 'http://127.0.0.1:8545',
  PAY_CRYPTO_CHAIN_ID: '31337',
  PAY_CRYPTO_DEPOSIT_MNEMONIC: 'test test test test test test test test test test test junk',
  PAY_CRYPTO_ASSETS: 'ETH:native',
  PAY_MIN_CONFIRMATIONS: '6',
};

describe('the plaintext hot-wallet key path is gone', () => {
  it('env.ts no longer declares a hot wallet key setting', () => {
    expect(read(join(SRC, 'env.ts'))).not.toMatch(/PAY_CRYPTO_HOT_WALLET_KEY/);
  });

  it('the chain options take a signer, never a key', () => {
    const chain = read(join(HERE, 'evm-chain.ts'));
    expect(chain).not.toMatch(/hotWalletKey/);
    expect(chain).not.toMatch(/privateKeyToAccount/);
  });

  it('posture.ts never reads a key from the environment', () => {
    expect(read(join(HERE, 'posture.ts'))).not.toMatch(/PAY_CRYPTO_HOT_WALLET_KEY/);
  });

  it('compose no longer forwards a hot wallet key to svc-pay', () => {
    expect(read(join(ROOT, 'docker-compose.apps.yml'))).not.toMatch(/PAY_CRYPTO_HOT_WALLET_KEY/);
  });

  it('a key left in the environment is ignored: with no signer chosen the live rail refuses', () => {
    expect(() => tryLiveChainFromEnv({ ...LIVE_ENV, PAY_CRYPTO_HOT_WALLET_KEY: FIXTURE_KEY }, new MemoryBroadcastStore())).toThrow(
      /pay\.signer_unset/,
    );
  });
});
