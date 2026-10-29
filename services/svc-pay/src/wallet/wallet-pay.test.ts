import { MemoryLedger, formatAmount, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { RailRegistry } from '../rails/registry.js';
import { UserMoneyService } from '../user-money-service.js';
import { SendOutDoor } from '../withdrawals/send-out/door.js';
import { NO_WITHDRAW_SIGNER, assertWithdrawSignerPosture } from '../withdrawals/send-out/signer-posture.js';
import {
  WalletPay,
  failClosedWalletPublish,
  railRetryWhileRequested,
  supportLabel,
  type ChainReader,
  type WalletAttempt,
  type WalletPublish,
} from './wallet-pay.js';

const USER = '11111111-1111-4111-8111-111111111111';
const STORED = 'bc1qstored';

function publish(overrides: Partial<WalletPublish> = {}): WalletPublish {
  return {
    networkFee: (_asset, _chain, address) => (address === STORED ? '0.00021' : null),
    withdrawalCap: () => '1',
    ...overrides,
  };
}

function harness(options?: { publish?: WalletPublish; open?: bigint }) {
  const wallet = new WalletPay({ publish: options?.publish ?? publish(), openHolds: async () => options?.open ?? 0n });
  return { wallet };
}

const accepted = (railRef: string | null = '0xabc'): WalletAttempt[] => [{ outcome: 'accepted', railRef }];

describe('SUP-0012 support labels an accepted send irreversible', () => {
  it('labels irreversible only for an accepted, stored, chain-confirmed send, and unknown otherwise', async () => {
    const confirmed: ChainReader = { confirm: async () => 'confirmed' };
    expect(await supportLabel(accepted(), confirmed)).toBe('irreversible');
    expect(await supportLabel([], confirmed)).toBe('unknown');
    expect(await supportLabel(accepted('  '), confirmed)).toBe('unknown');
    expect(await supportLabel([{ outcome: 'requested', railRef: 'x' }], confirmed)).toBe('unknown');
    expect(await supportLabel(accepted(), { confirm: async () => 'down' })).toBe('unknown');
    expect(
      await supportLabel(accepted(), {
        confirm: async () => {
          throw new Error('chain reader down');
        },
      }),
    ).toBe('unknown');
  });
});

describe('WAL-0163 a requested attempt is not asked again', () => {
  it('names a requested attempt as unknown and anything else as askable', () => {
    expect(railRetryWhileRequested('requested')).toBe('unknown');
    expect(railRetryWhileRequested('accepted')).toBe('ask');
    expect(railRetryWhileRequested(null)).toBe('ask');
  });
});

describe('WAL-0047 and WAL-0079 network fee', () => {
  it('returns the estimate for that address and marks nothing sent', async () => {
    const { wallet } = harness();
    expect(await wallet.estimateFee({ assetId: 'BTC', chain: 'BTC', address: STORED })).toEqual({
      fee: '0.00021',
      assetId: 'BTC',
      address: STORED,
      sent: false,
    });
  });

  it('refuses a blank fee, and the deployment publishes none (the fee a send carries is its quote)', async () => {
    const blank = harness({ publish: publish({ networkFee: () => '   ' }) });
    await expect(blank.wallet.estimateFee({ assetId: 'BTC', chain: 'BTC', address: STORED })).rejects.toMatchObject({
      code: 'pay.wallet_fee_unset',
    });
    const shipped = harness({ publish: failClosedWalletPublish() });
    await expect(shipped.wallet.estimateFee({ assetId: 'BTC', chain: 'BTC', address: STORED })).rejects.toMatchObject({
      code: 'pay.wallet_fee_unset',
    });
  });
});

describe('the remaining cap read', () => {
  it('is the published cap less the open holds, never below zero, and refuses a blank cap', async () => {
    expect(await harness({ open: parseAmount('0.6') }).wallet.remainingCap(USER, 'BTC')).toBe('0.4');
    expect(await harness({ open: parseAmount('3') }).wallet.remainingCap(USER, 'BTC')).toBe('0');
    await expect(harness({ publish: publish({ withdrawalCap: () => ' ' }) }).wallet.remainingCap(USER, 'BTC')).rejects.toMatchObject({
      code: 'pay.wallet_cap_unset',
    });
  });
});

describe('WAL-0186 a send out with no custody signer posts no hold (J-wallet-05 #7)', () => {
  it.each([
    ['on a network with no signer', 'crypto-native', 'base', { kind: 'crypto', ref: '0x52908400098527886E0F7030069857D2E4169EE7' }],
    ['naming no network', 'crypto-native', undefined, { kind: 'crypto', ref: '0x52908400098527886E0F7030069857D2E4169EE7' }],
    ['on a rail no signer sends', 'card-sandbox', 'ethereum', { kind: 'bank', ref: 'DE89370400440532013000' }],
  ] as const)('refuses the customer withdraw door on the service %s', async (_case, rail, networkId, destination) => {
    const ledger = new MemoryLedger();
    const asked: unknown[] = [];
    const sendOut = new SendOutDoor({
      signer: assertWithdrawSignerPosture({ APP_ENV: 'test', PAY_TEST_WITHDRAW_SIGNER_NETWORKS: 'ethereum' }),
      destinations: { check: async (input) => (asked.push(input), { state: 'ready', destinationId: null, coolingOffEndsAt: null }) },
    });
    const sql = (() => Promise.resolve([])) as unknown as Sql;
    const money = new UserMoneyService(sql, ledger, new RailRegistry([]), { operatorCreditRails: [], sendOut });
    await ledger.post(
      recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('5'), rail: 'crypto-native', railRef: 'seed-door' }),
    );
    const before = ledger.journal().length;
    await expect(
      money.withdraw({
        userId: USER,
        assetId: 'USDT',
        amount: parseAmount('1'),
        rail,
        destination,
        clientRef: 'door-1',
        networkId,
        quoteRef: 'q-door-1',
      }),
    ).rejects.toMatchObject({ code: 'pay.wallet_withdraw_unavailable' });
    expect(ledger.journal().length).toBe(before);
    expect(asked).toEqual([]);
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('5');
  });

  it('has no signer anywhere by default', () => {
    expect(NO_WITHDRAW_SIGNER.testNetworks.size).toBe(0);
    expect(assertWithdrawSignerPosture({ APP_ENV: 'prod' }).testNetworks.size).toBe(0);
  });
});

describe('D-128 one withdrawal and deposit engine', () => {
  it('only user-money-service.ts and payment-service.ts post withdrawal and deposit recipes', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && !/\.test\.ts$/.test(name) && !name.endsWith('.d.ts')) files.push(path);
      }
    };
    walk(root);
    // payment-service/internal.ts holds PayService's legacy payout plan, moved there from payment-service.ts.
    const allowed = new Set(['user-money-service.ts', 'payment-service.ts', 'payment-service/internal.ts']);
    const offenders = files
      .filter((file) => /recipes\.(withdrawHold|withdrawSettle|withdrawReverse|deposit)\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file))
      .filter((file) => !allowed.has(file));
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(20);
  });
});
