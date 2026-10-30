import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { ChainSendRefusedError, MemoryChain } from './chain-port.js';
import { CryptoNativeAdapter } from './crypto-native.js';
import { MEMORY_CHAIN_MAX_SEND_DELAY_MS, defaultChainFor, memoryChainPaceFromEnv } from './posture.js';

const SECRET = 'memory-chain-pace-secret';
const TO = '0x52908400098527886E0F7030069857D2E4169EE7';

const instruction = (amount: string, settlementId = 'w-1:0') => ({
  settlementId,
  merchantId: 'user-1',
  amount: amt(amount),
  assetId: 'USDT',
  window: 'user-withdrawal',
  destination: { kind: 'crypto', ref: TO },
});

describe('the in-memory chain TEST pace (J-wallet-05 #8)', () => {
  it('is no pace when neither setting is set', () => {
    expect(memoryChainPaceFromEnv({ APP_ENV: 'prod' })).toEqual({});
    expect(memoryChainPaceFromEnv({ APP_ENV: 'dev', PAY_TEST_CHAIN_SEND_DELAY_MS: ' ', PAY_TEST_CHAIN_REFUSE_AMOUNT: '' })).toEqual({});
  });

  it('reads a delay and a refused amount in dev and test', () => {
    expect(memoryChainPaceFromEnv({ APP_ENV: 'test', PAY_TEST_CHAIN_SEND_DELAY_MS: '4000', PAY_TEST_CHAIN_REFUSE_AMOUNT: '13' })).toEqual({
      sendDelayMs: 4000,
      refuseAmount: amt('13'),
    });
    expect(memoryChainPaceFromEnv({ APP_ENV: 'dev', PAY_TEST_CHAIN_SEND_DELAY_MS: '0' })).toEqual({ sendDelayMs: 0 });
  });

  it('refuses to boot when set anywhere but dev or test, or unset APP_ENV', () => {
    for (const APP_ENV of ['staging', 'prod', 'production', 'Dev', undefined]) {
      expect(() => memoryChainPaceFromEnv({ APP_ENV, PAY_TEST_CHAIN_SEND_DELAY_MS: '10' }), String(APP_ENV)).toThrow(/TEST settings/);
      expect(() => memoryChainPaceFromEnv({ APP_ENV, PAY_TEST_CHAIN_REFUSE_AMOUNT: '13' }), String(APP_ENV)).toThrow(/TEST settings/);
    }
  });

  it('refuses to boot on a value that does not parse, rather than quietly doing nothing', () => {
    const dev = (env: Record<string, string>) => () => memoryChainPaceFromEnv({ APP_ENV: 'dev', ...env });
    expect(dev({ PAY_TEST_CHAIN_SEND_DELAY_MS: '4s' })).toThrow(/whole milliseconds/);
    expect(dev({ PAY_TEST_CHAIN_SEND_DELAY_MS: '-1' })).toThrow(/whole milliseconds/);
    expect(dev({ PAY_TEST_CHAIN_SEND_DELAY_MS: '1.5' })).toThrow(/whole milliseconds/);
    expect(dev({ PAY_TEST_CHAIN_SEND_DELAY_MS: String(MEMORY_CHAIN_MAX_SEND_DELAY_MS + 1) })).toThrow(/whole milliseconds/);
    expect(dev({ PAY_TEST_CHAIN_REFUSE_AMOUNT: 'thirteen' })).toThrow(/exact decimal/);
    expect(dev({ PAY_TEST_CHAIN_REFUSE_AMOUNT: '0' })).toThrow(/above zero/);
  });

  it('paces only the in-memory chain: a pace in staging or prod, or beside a live chain, refuses to boot', () => {
    expect(() => defaultChainFor({ APP_ENV: 'prod', PAY_TEST_CHAIN_SEND_DELAY_MS: '10' })).toThrow(/TEST settings/);
    expect(() => defaultChainFor({ APP_ENV: 'staging', PAY_TEST_CHAIN_REFUSE_AMOUNT: '13' })).toThrow(/TEST settings/);
    const live = {
      APP_ENV: 'dev',
      PAY_CRYPTO_RPC_URL: 'http://127.0.0.1:8545',
      PAY_CRYPTO_CHAIN_ID: '31337',
      PAY_CRYPTO_DEPOSIT_SOURCE: 'testnet',
      PAY_CRYPTO_SIGNER: 'testnet',
      PAY_CRYPTO_ASSETS: 'ETH:native',
      PAY_MIN_CONFIRMATIONS: '6',
    };
    expect(() => defaultChainFor({ ...live, PAY_TEST_CHAIN_SEND_DELAY_MS: '10' })).toThrow(/only the in-memory chain/);
    expect(defaultChainFor({ APP_ENV: 'dev', PAY_TEST_CHAIN_SEND_DELAY_MS: '10' })).toBeInstanceOf(MemoryChain);
    expect(() => defaultChainFor({ APP_ENV: 'dev', PAY_TEST_CHAIN_SEND_DELAY_MS: 'soon' })).toThrow(/whole milliseconds/);
  });

  it('refuses a send of exactly the refused amount before anything is recorded, and sends any other amount', async () => {
    const chain = new MemoryChain({ refuseAmount: amt('13') });
    await expect(chain.send({ to: TO, assetId: 'USDT', amount: amt('13'), idempotencyKey: 'k-13' })).rejects.toBeInstanceOf(
      ChainSendRefusedError,
    );
    expect(await chain.lookupSend('k-13')).toEqual({ state: 'not_sent' });
    expect(chain.totalSent('USDT')).toBe('0');
    await expect(chain.send({ to: TO, assetId: 'USDT', amount: amt('13.01'), idempotencyKey: 'k-1301' })).resolves.toMatchObject({
      txHash: expect.any(String),
    });
  });

  it('records a delayed send before it answers, so a status query during the wait finds it sent, and a repeat sends once', async () => {
    const chain = new MemoryChain({ sendDelayMs: 200 });
    let answered = false;
    const sending = chain.send({ to: TO, assetId: 'USDT', amount: amt('25'), idempotencyKey: 'k-25' }).then((r) => {
      answered = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);
    expect(await chain.lookupSend('k-25')).toMatchObject({ state: 'sent', amount: amt('25') });
    const repeat = await chain.send({ to: TO, assetId: 'USDT', amount: amt('25'), idempotencyKey: 'k-25' });
    const first = await sending;
    expect(repeat).toEqual(first);
    expect(chain.totalSent('USDT')).toBe('25');
  });

  it('crypto-native turns a refusal before broadcast into a rail.refused failure, never an unknown outcome', async () => {
    const chain = new MemoryChain({ refuseAmount: amt('13') });
    const rail = new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });
    const refused = await rail.payout(instruction('13'));
    expect(refused).toMatchObject({ ok: false, failureCode: 'rail.refused', amount: amt('13'), assetId: 'USDT' });
    expect(chain.totalSent('USDT')).toBe('0');
    expect(await rail.payout(instruction('12', 'w-2:0'))).toMatchObject({ ok: true, amount: amt('12') });
  });
});
