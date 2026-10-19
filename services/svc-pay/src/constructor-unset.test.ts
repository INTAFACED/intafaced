import { readFileSync } from 'node:fs';
import { TestnetDepositAddresses } from './rails/deposit-source.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryChain } from './rails/chain-port.js';
import { MemoryBroadcastStore } from './rails/broadcast-store.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';
import { EvmLiveChain } from './rails/evm-chain.js';
import { TestnetSigner } from './rails/evm-signer.js';
import type { EvmLiveChainOptions } from './rails/evm-chain.js';
import { verifyMerchantWebhook, signMerchantWebhook } from './plugins/reference-client.js';
import { frozenWebhookVectors } from './plugins/webhook-vectors.js';

/**
 * Constructor leftover after #4008: env refuse is not enough if rails still
 * `minConfirmations ?? 6` and merchant verify still `toleranceSeconds ?? 300`.
 *
 * Blank refuses. Owner-explicit 6 / 300 is allowed.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'constructor-unset-secret-at-least-32-chars';

describe('svc-pay constructor unset refuse', () => {
  it('rails do not invent minConfirmations 6', () => {
    const crypto = readFileSync(join(ROOT, 'services/svc-pay/src/rails/crypto-native.ts'), 'utf8');
    const evm = readFileSync(join(ROOT, 'services/svc-pay/src/rails/evm-chain.ts'), 'utf8');
    expect(crypto).not.toMatch(/minConfirmations \?\? 6/);
    expect(evm).not.toMatch(/minConfirmations \?\? 6/);
    expect(crypto).toMatch(/readonly minConfirmations: number;/);
    expect(evm).toMatch(/readonly minConfirmations: number;/);
  });

  it('verifyMerchantWebhook does not invent 300', () => {
    const src = readFileSync(join(ROOT, 'services/svc-pay/src/plugins/reference-client.ts'), 'utf8');
    expect(src).not.toMatch(/toleranceSeconds \?\? 300/);
    expect(src).toMatch(/readonly toleranceSeconds: number;/);
  });

  it('CryptoNativeAdapter refuses blank minConfirmations — owner 6 is allowed', () => {
    const chain = new MemoryChain();
    expect(
      () =>
        new CryptoNativeAdapter({
          chain,
          secret: SECRET,
          minConfirmations: undefined as unknown as number,
          toleranceSeconds: 300,
        }),
    ).toThrow(/minConfirmations is unset/);
    expect(new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 }).id).toBe('crypto-native');
  });

  it('EvmLiveChain refuses blank minConfirmations before any chain client is built', () => {
    const incomplete = {
      rpcUrl: 'http://127.0.0.1:1',
      chainId: 1,
      deposits: TestnetDepositAddresses.default(),
      signer: TestnetSigner.fromFixtureKey('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
      assets: new Map(),
      broadcasts: new MemoryBroadcastStore(),
      minConfirmations: undefined,
    } as unknown as EvmLiveChainOptions;
    expect(() => new EvmLiveChain(incomplete)).toThrow(/minConfirmations is unset/);
  });

  it('verifyMerchantWebhook refuses blank tolerance — owner 300 is allowed', () => {
    const v = frozenWebhookVectors()[0]!;
    const now = new Date(Number(v.timestampSeconds) * 1000);
    expect(() =>
      verifyMerchantWebhook({
        secret: v.secret,
        rawBody: v.rawBody,
        signatureHex: v.signatureHex,
        timestampSeconds: v.timestampSeconds,
        now,
        toleranceSeconds: undefined as unknown as number,
      }),
    ).toThrow(/toleranceSeconds is unset/);
    expect(
      verifyMerchantWebhook({
        secret: v.secret,
        rawBody: v.rawBody,
        signatureHex: v.signatureHex,
        timestampSeconds: v.timestampSeconds,
        now,
        toleranceSeconds: 300,
      }),
    ).toBe(true);
    expect(signMerchantWebhook(v.secret, v.timestampSeconds, v.rawBody)).toBe(v.signatureHex);
  });
});
