import { MemoryLedger, formatAmount, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { RailRegistry } from '../rails/registry.js';
import { UserMoneyService } from '../user-money-service.js';
import {
  ALLOWLIST_CALLBACK_TIMEOUT_MS,
  WalletPay,
  railRetryWhileRequested,
  supportLabel,
  type ChainReader,
  type CustomerWithdrawalInput,
  type WalletAttempt,
  type WalletPublish,
} from './wallet-pay.js';

const USER = '11111111-1111-4111-8111-111111111111';
const STORED = 'bc1qstored';
const NOW = new Date('2026-10-18T00:00:00.000Z');

function publish(overrides: Partial<WalletPublish> = {}): WalletPublish {
  return {
    withdrawFeatureStatus: 'live',
    depositMinimum: (assetId, network) => (assetId === 'USDT' && network === 'ETH' ? '10' : null),
    networkFee: (_asset, _chain, address) => (address === STORED ? '0.00021' : null),
    withdrawalCap: () => '1',
    withdrawEnabled: () => true,
    coolingHours: 24,
    storedDestination: () => ({ ref: STORED, updatedAt: new Date('2026-10-01T00:00:00.000Z') }),
    kycTier: () => 'basic',
    acceptanceAddresses: new Set(['0xaccept']),
    travelRuleFields: ['beneficiary_name', 'residential_address', 'wallet_type'],
    railRequiresBeneficiary: true,
    ...overrides,
  };
}

function ready(overrides: Partial<CustomerWithdrawalInput> = {}): CustomerWithdrawalInput {
  return {
    userId: USER,
    assetId: 'BTC',
    network: 'BTC',
    amount: parseAmount('0.4'),
    clientRef: 'client-1',
    shownFee: '0.00021',
    recipient: {
      beneficiary_name: 'Ada Lovelace',
      residential_address: '1 Analytical Engine Road',
      wallet_type: 'self-hosted',
    },
    destinationAdheres: true,
    allowlistCallback: async () => 'ok',
    railRequiresBeneficiary: true,
    ...overrides,
  };
}

function harness(options?: { publish?: WalletPublish; allow?: boolean; timeoutMs?: number; open?: bigint }) {
  const wallet = new WalletPay({
    publish: options?.publish ?? publish(),
    openHolds: async () => options?.open ?? 0n,
    allowlist: { has: () => options?.allow !== false },
    now: () => NOW,
    callbackTimeoutMs: options?.timeoutMs,
  });
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

const gate = (wallet: WalletPay, input?: Partial<CustomerWithdrawalInput>) => wallet.assertCustomerWithdrawal(ready(input));

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

  it('refuses a blank fee and a fee that differs from the preview', async () => {
    const blank = harness({ publish: publish({ networkFee: () => '   ' }) });
    await expect(gate(blank.wallet, { shownFee: null })).rejects.toMatchObject({ code: 'pay.wallet_fee_unset' });
    await expect(blank.wallet.estimateFee({ assetId: 'BTC', chain: 'BTC', address: STORED })).rejects.toMatchObject({
      code: 'pay.wallet_fee_unset',
    });
    const differs = harness();
    await expect(gate(differs.wallet, { shownFee: '0.9' })).rejects.toMatchObject({
      code: 'pay.wallet_fee_differs',
      detail: { fee: '0.00021' },
    });
  });
});

describe('WAL-0037 WAL-0083 WAL-0138 WAL-0139 WAL-0140 travel-rule fields', () => {
  it('names the missing field, and refuses a blank payload and a destination that will not take it', async () => {
    const { wallet } = harness();
    await expect(gate(wallet, { recipient: { residential_address: '1 Road', wallet_type: 'self-hosted' } })).rejects.toMatchObject({
      code: 'pay.wallet_travel_rule',
      detail: { missingFields: ['beneficiary_name'] },
    });
    await expect(gate(wallet, { recipient: {} })).rejects.toMatchObject({ code: 'pay.wallet_travel_rule' });
    await expect(gate(wallet, { destinationAdheres: false })).rejects.toMatchObject({ code: 'pay.wallet_destination_rejected' });
    await expect(gate(wallet, { destinationAdheres: 'timeout' })).rejects.toMatchObject({ code: 'pay.wallet_share_timeout' });
  });
});

describe('WAL-0143 allowlist callback', () => {
  it('refuses an empty body, a callback that is not ok, and an address off the allowlist', async () => {
    const { wallet } = harness();
    await expect(gate(wallet, { allowlistCallback: async () => '' })).rejects.toMatchObject({ code: 'pay.wallet_allowlist' });
    const off = harness({ allow: false });
    await expect(gate(off.wallet)).rejects.toMatchObject({ code: 'pay.wallet_allowlist' });
  });

  it('treats a 5 second callback timeout as a refusal', async () => {
    expect(ALLOWLIST_CALLBACK_TIMEOUT_MS).toBe(5_000);
    const { wallet } = harness({ timeoutMs: 20 });
    await expect(gate(wallet, { allowlistCallback: () => new Promise<string>(() => undefined) })).rejects.toMatchObject({
      code: 'pay.wallet_allowlist',
    });
  });

  it('passes with every rule met and returns the stored destination', async () => {
    const { wallet } = harness();
    expect(await gate(wallet)).toBe(STORED);
  });
});

describe('WAL-0168 stored destination and cooling, not a typed address', () => {
  it('refuses a different address', async () => {
    const { wallet } = harness();
    await expect(gate(wallet, { typedAddress: 'bc1qother' })).rejects.toMatchObject({ code: 'pay.wallet_typed_address' });
  });

  it('refuses inside a 24 hour cooling window and when the window is blank', async () => {
    const { wallet } = harness({
      publish: publish({ storedDestination: () => ({ ref: STORED, updatedAt: new Date('2026-10-17T12:00:00.000Z') }) }),
    });
    await expect(gate(wallet)).rejects.toMatchObject({ code: 'pay.wallet_cooling' });
    const blank = harness({ publish: publish({ coolingHours: null }) });
    await expect(gate(blank.wallet)).rejects.toMatchObject({ code: 'pay.wallet_cooling' });
  });
});

describe('WAL-0177 a disabled account is refused', () => {
  it('refuses a new withdrawal when withdrawals are off for the account', async () => {
    const { wallet } = harness({ publish: publish({ withdrawEnabled: () => false }) });
    await expect(gate(wallet)).rejects.toMatchObject({ code: 'pay.wallet_withdraw_disabled' });
  });
});

describe('WAL-0186 a hidden or blocked withdraw feature posts no hold', () => {
  it.each(['hidden', 'blocked'] as const)(
    'refuses the customer withdraw door on the service when the published status is %s',
    async (status) => {
      const ledger = new MemoryLedger();
      const wallet = new WalletPay({
        publish: publish({ withdrawFeatureStatus: status }),
        openHolds: async () => 0n,
        allowlist: { has: () => false },
        now: () => NOW,
      });
      const sql = (() => Promise.resolve([])) as unknown as Sql;
      const money = new UserMoneyService(sql, ledger, new RailRegistry([]), { operatorCreditRails: [], wallet });
      await ledger.post(
        recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('5'), rail: 'crypto-native', railRef: 'seed-door' }),
      );
      const before = ledger.journal().length;
      await expect(
        money.withdraw({
          userId: USER,
          assetId: 'USDT',
          amount: parseAmount('1'),
          rail: 'card-sandbox',
          destination: { kind: 'bank', ref: 'DE89370400440532013000' },
          clientRef: 'door-1',
        }),
      ).rejects.toMatchObject({ code: 'pay.wallet_withdraw_unavailable' });
      expect(ledger.journal().length).toBe(before);
      expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('5');
    },
  );
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
