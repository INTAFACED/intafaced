import { MemoryLedger, formatAmount, parseAmount, recipes, userAvailable, withdrawalHoldAccount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { RailRegistry } from '../rails/registry.js';
import { UserMoneyService } from '../user-money-service.js';
import {
  ALLOWLIST_CALLBACK_TIMEOUT_MS,
  MemoryWalletStore,
  WalletPay,
  railRetryWhileRequested,
  type ChainReader,
  type CustomerWithdrawalInput,
  type WalletPublish,
  type WalletRail,
  type WalletStore,
  type WalletWithdrawal,
} from './wallet-pay.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
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

function harness(options?: { publish?: WalletPublish; chain?: ChainReader; allow?: boolean; timeoutMs?: number; rail?: WalletRail }) {
  const ledger = new MemoryLedger();
  const store = new MemoryWalletStore();
  const payouts: unknown[] = [];
  const rail = options?.rail ?? {
    payout: async (input) => {
      payouts.push(input);
      return { ok: true as const, railRef: '0xsent', amount: input.amount, assetId: input.assetId };
    },
  };
  let posts = 0;
  const post = ledger.post.bind(ledger);
  ledger.post = async (request) => {
    posts += 1;
    return post(request);
  };
  const wallet = new WalletPay({
    ledger,
    store,
    publish: options?.publish ?? publish(),
    chainReader: options?.chain ?? { confirm: async () => 'confirmed' },
    rail,
    allowlist: { has: () => options?.allow !== false },
    now: () => NOW,
    callbackTimeoutMs: options?.timeoutMs,
  });
  return { ledger, store, wallet, payouts, posts: () => posts };
}

async function fund(ledger: MemoryLedger, assetId: string, amount: string, railRef: string) {
  await ledger.post(
    recipes.deposit({
      userId: USER,
      assetId,
      amount: parseAmount(amount),
      rail: 'crypto-native',
      railRef,
    }),
  );
}

async function available(wallet: WalletPay, assetId: string): Promise<string> {
  return formatAmount(await wallet.available(USER, assetId));
}

describe('SUP-0012 support labels an accepted send irreversible', () => {
  it('labels irreversible with no recall control, and a read posts nothing', async () => {
    const { wallet, store, posts } = harness();
    await store.saveWithdrawal(sentRow());
    const first = await wallet.supportRead({ withdrawalId: 'wd-sent', ownerUserId: USER });
    const second = await wallet.supportRead({ withdrawalId: 'wd-sent', ownerUserId: USER });
    expect(first.label).toBe('irreversible');
    expect(first.controls).not.toContain('recall');
    expect(first).not.toHaveProperty('recall');
    expect(second).toEqual(first);
    expect((await store.getWithdrawal('wd-sent'))?.status).toBe('sent');
    expect(posts()).toBe(0);
    expect(await available(wallet, 'BTC')).toBe('0');
  });

  it('keeps a missing attempt unknown and a down chain reader unknown', async () => {
    const missing = harness();
    await missing.store.saveWithdrawal({ ...sentRow(), attempts: [] });
    expect((await missing.wallet.supportRead({ withdrawalId: 'wd-sent', ownerUserId: USER })).label).toBe('unknown');

    const down = harness({ chain: { confirm: async () => 'down' } });
    await down.store.saveWithdrawal(sentRow());
    expect((await down.wallet.supportRead({ withdrawalId: 'wd-sent', ownerUserId: USER })).label).toBe('unknown');

    const thrown = harness({
      chain: {
        confirm: async () => {
          throw new Error('chain reader down');
        },
      },
    });
    await thrown.store.saveWithdrawal(sentRow());
    expect((await thrown.wallet.supportRead({ withdrawalId: 'wd-sent', ownerUserId: USER })).label).toBe('unknown');
  });
});

describe('WAL-0162 support reads each attempt for the owner only', () => {
  it('returns the requested outcome and rail ref, and forbids another user', async () => {
    const { wallet, store } = harness();
    await store.saveWithdrawal({
      ...sentRow(),
      status: 'held',
      attempts: [{ outcome: 'requested', railRef: 'rail-9' }],
    });
    const read = await wallet.supportRead({ withdrawalId: 'wd-sent', ownerUserId: USER });
    expect(read.attempts).toEqual([{ outcome: 'requested', railRef: 'rail-9' }]);
    await expect(wallet.supportRead({ withdrawalId: 'wd-sent', ownerUserId: OTHER })).rejects.toMatchObject({
      code: 'pay.wallet_forbidden',
    });
  });
});

describe('WAL-0163 a requested attempt is not asked again', () => {
  it('returns pay.rail_outcome_unknown and does not call payout', async () => {
    expect(railRetryWhileRequested('requested')).toBe('unknown');
    expect(railRetryWhileRequested('accepted')).toBe('ask');
    const box = harness();
    await fund(box.ledger, 'BTC', '2', 'seed-retry');
    await box.store.saveWithdrawal({
      ...sentRow(),
      id: 'wd-req',
      status: 'held',
      holdAmount: parseAmount('0.4'),
      clientRef: 'client-1',
      attempts: [{ outcome: 'requested', railRef: null }],
    });
    await expect(box.wallet.submitWithdrawal(ready())).rejects.toMatchObject({ code: 'pay.rail_outcome_unknown' });
    expect(box.payouts).toHaveLength(0);
    expect((await box.store.getWithdrawal('wd-req'))?.status).toBe('held');
  });
});

describe('WAL-0007 a blank owner minimum refuses credit', () => {
  it('does not post and leaves available unchanged', async () => {
    const { wallet, posts } = harness({
      publish: publish({ depositMinimum: () => null, kycTier: () => 'basic' }),
    });
    await expect(
      wallet.deliverInbound({
        userId: USER,
        assetId: 'USDT',
        network: 'ETH',
        amount: parseAmount('25'),
        railRef: '0xtx',
        acceptanceAddress: '0xaccept',
        finalized: true,
        sessionOpen: false,
      }),
    ).rejects.toMatchObject({ code: 'pay.wallet_minimum_unset' });
    expect(posts()).toBe(0);
    expect(await available(wallet, 'USDT')).toBe('0');
    expect(await wallet.listUncredited()).toEqual([]);
  });
});

describe('WAL-0008 a below-minimum inbound stays uncredited', () => {
  it('records the inbound and does not increase available', async () => {
    const { wallet, posts } = harness({
      publish: publish({ depositMinimum: () => '10', kycTier: () => 'basic' }),
    });
    const row = await wallet.deliverInbound({
      userId: USER,
      assetId: 'USDT',
      network: 'ETH',
      amount: parseAmount('9.5'),
      railRef: '0xdust',
      acceptanceAddress: '0xaccept',
      finalized: true,
      sessionOpen: true,
    });
    expect(row.status).toBe('uncredited');
    expect(row.reason).toBe('below-minimum');
    expect(await wallet.listUncredited()).toEqual([expect.objectContaining({ railRef: '0xdust', amount: parseAmount('9.5') })]);
    expect(posts()).toBe(0);
    expect(await available(wallet, 'USDT')).toBe('0');
  });
});

describe('WAL-0155 tier none stays uncredited until verification', () => {
  it('posts once after the tier changes and not a second time', async () => {
    let tier: 'none' | 'basic' = 'none';
    const { wallet, posts } = harness({
      publish: publish({
        kycTier: () => tier,
        depositMinimum: () => '10',
      }),
    });
    const input = {
      userId: USER,
      assetId: 'USDT',
      network: 'ETH',
      amount: parseAmount('12'),
      railRef: '0xsame',
      acceptanceAddress: '0xaccept',
      finalized: true,
      sessionOpen: false,
    };
    const first = await wallet.deliverInbound(input);
    expect(first.status).toBe('uncredited');
    expect(await available(wallet, 'USDT')).toBe('0');
    expect(posts()).toBe(0);
    tier = 'basic';
    const second = await wallet.deliverInbound(input);
    expect(second.status).toBe('credited');
    expect(await available(wallet, 'USDT')).toBe('12');
    expect(posts()).toBe(1);
    await wallet.deliverInbound(input);
    expect(await available(wallet, 'USDT')).toBe('12');
    expect(posts()).toBe(1);
  });
});

describe('WAL-0166 an offline finalized inbound credits once', () => {
  it('credits the acceptance address once and ignores an unmatched delivery', async () => {
    const { wallet } = harness({
      publish: publish({ depositMinimum: () => '10', kycTier: () => 'basic' }),
    });
    const credited = await wallet.deliverInbound({
      userId: USER,
      assetId: 'USDT',
      network: 'ETH',
      amount: parseAmount('15'),
      railRef: '0xfinal',
      acceptanceAddress: '0xaccept',
      finalized: true,
      sessionOpen: false,
    });
    expect(credited.status).toBe('credited');
    expect(await available(wallet, 'USDT')).toBe('15');
    await wallet.deliverInbound({
      userId: USER,
      assetId: 'USDT',
      network: 'ETH',
      amount: parseAmount('15'),
      railRef: '0xfinal',
      acceptanceAddress: '0xaccept',
      finalized: true,
      sessionOpen: false,
    });
    expect(await available(wallet, 'USDT')).toBe('15');
    await wallet.deliverInbound({
      userId: USER,
      assetId: 'USDT',
      network: 'ETH',
      amount: parseAmount('15'),
      railRef: '0xother',
      acceptanceAddress: '0xnot-ours',
      finalized: true,
      sessionOpen: false,
    });
    expect(await available(wallet, 'USDT')).toBe('15');
  });
});

describe('WAL-0047 and WAL-0079 network fee', () => {
  it('returns the estimate for that address and does not mark a withdrawal sent', async () => {
    const { wallet, store } = harness();
    const estimate = await wallet.estimateFee({ assetId: 'BTC', chain: 'BTC', address: STORED });
    expect(estimate).toEqual({ fee: '0.00021', assetId: 'BTC', address: STORED, sent: false });
    expect(await store.listWithdrawals(USER, 'BTC')).toEqual([]);
  });

  it('refuses a blank fee and a fee that differs from the preview, with no hold', async () => {
    const blank = harness({ publish: publish({ networkFee: () => '   ' }) });
    await fund(blank.ledger, 'BTC', '2', 'seed-fee');
    const before = await available(blank.wallet, 'BTC');
    await expect(blank.wallet.submitWithdrawal(ready({ shownFee: null }))).rejects.toMatchObject({
      code: 'pay.wallet_fee_unset',
    });
    expect(blank.payouts).toHaveLength(0);
    expect(await available(blank.wallet, 'BTC')).toBe(before);
    expect(await blank.store.listWithdrawals(USER, 'BTC')).toEqual([]);

    const differs = harness();
    await fund(differs.ledger, 'BTC', '2', 'seed-fee-2');
    await expect(differs.wallet.submitWithdrawal(ready({ shownFee: '0.9' }))).rejects.toMatchObject({
      code: 'pay.wallet_fee_differs',
      detail: { fee: '0.00021' },
    });
    expect(differs.payouts).toHaveLength(0);
    expect(await differs.store.listWithdrawals(USER, 'BTC')).toEqual([]);
  });
});

describe('WAL-0082 the published remaining cap is the figure that is checked', () => {
  it('refuses 1.1 BTC when the remaining cap is 1 BTC and counts an open hold', async () => {
    const { wallet, ledger, store, payouts } = harness();
    await fund(ledger, 'BTC', '3', 'seed-cap');
    await expect(wallet.submitWithdrawal(ready({ amount: parseAmount('1.1'), clientRef: 'over' }))).rejects.toMatchObject({
      code: 'pay.wallet_over_cap',
      detail: { remainingCap: '1' },
    });
    expect(await wallet.remainingCap(USER, 'BTC')).toBe('1');
    expect(payouts).toHaveLength(0);

    await seedHold(store, ledger, '0.2', 'wd-open');
    await expect(wallet.submitWithdrawal(ready({ amount: parseAmount('0.9'), clientRef: 'still-over' }))).rejects.toMatchObject({
      code: 'pay.wallet_over_cap',
      detail: { remainingCap: '0.8' },
    });
    expect(await wallet.remainingCap(USER, 'BTC')).toBe('0.8');
  });
});

describe('WAL-0037 WAL-0083 WAL-0138 WAL-0139 WAL-0140 travel-rule fields', () => {
  it('names beneficiary_name, does not hold, and does not ask the rail', async () => {
    const { wallet, ledger, payouts, posts } = harness();
    await fund(ledger, 'BTC', '2', 'seed-travel');
    const beforePosts = posts();
    await expect(
      wallet.submitWithdrawal(
        ready({
          recipient: { residential_address: '1 Road', wallet_type: 'self-hosted' },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'pay.wallet_travel_rule',
      detail: { missingFields: ['beneficiary_name'] },
    });
    expect(payouts).toHaveLength(0);
    expect(posts()).toBe(beforePosts);
    expect(await wallet.available(USER, 'BTC')).toEqual(parseAmount('2'));
  });

  it('refuses a blank payload and a destination that will not take it, without a debit', async () => {
    const blank = harness();
    await fund(blank.ledger, 'BTC', '2', 'seed-blank');
    await expect(blank.wallet.submitWithdrawal(ready({ recipient: {} }))).rejects.toMatchObject({
      code: 'pay.wallet_travel_rule',
    });
    expect(blank.payouts).toHaveLength(0);
    expect(await available(blank.wallet, 'BTC')).toBe('2');

    const rejected = harness();
    await fund(rejected.ledger, 'BTC', '2', 'seed-reject');
    await expect(rejected.wallet.submitWithdrawal(ready({ destinationAdheres: false }))).rejects.toMatchObject({
      code: 'pay.wallet_destination_rejected',
    });
    expect(rejected.payouts).toHaveLength(0);
    expect(await available(rejected.wallet, 'BTC')).toBe('2');

    const timed = harness();
    await fund(timed.ledger, 'BTC', '2', 'seed-timeout');
    await expect(timed.wallet.submitWithdrawal(ready({ destinationAdheres: 'timeout' }))).rejects.toMatchObject({
      code: 'pay.wallet_share_timeout',
    });
    expect(timed.payouts).toHaveLength(0);
    expect(await available(timed.wallet, 'BTC')).toBe('2');
  });
});

describe('WAL-0141 a destination that does not adhere is not sent', () => {
  it('fails the withdrawal and leaves available unchanged', async () => {
    const { wallet, ledger, payouts } = harness();
    await fund(ledger, 'BTC', '2', 'seed-adhere');
    await expect(wallet.submitWithdrawal(ready({ destinationAdheres: false, clientRef: 'adh' }))).rejects.toMatchObject({
      code: 'pay.wallet_destination_rejected',
    });
    await expect(wallet.submitWithdrawal(ready({ destinationAdheres: false, clientRef: 'adh' }))).rejects.toMatchObject({
      code: 'pay.wallet_destination_rejected',
    });
    expect(payouts).toHaveLength(0);
    expect(await available(wallet, 'BTC')).toBe('2');
  });
});

describe('WAL-0143 allowlist callback', () => {
  it('refuses an empty body and a callback that does not return ok', async () => {
    const empty = harness();
    await fund(empty.ledger, 'BTC', '2', 'seed-empty');
    await expect(empty.wallet.submitWithdrawal(ready({ allowlistCallback: async () => '' }))).rejects.toMatchObject({
      code: 'pay.wallet_allowlist',
    });
    expect(empty.payouts).toHaveLength(0);

    const off = harness({ allow: false });
    await fund(off.ledger, 'BTC', '2', 'seed-off');
    await expect(off.wallet.submitWithdrawal(ready())).rejects.toMatchObject({ code: 'pay.wallet_allowlist' });
    expect(off.payouts).toHaveLength(0);
    expect(await available(off.wallet, 'BTC')).toBe('2');
  });

  it('treats a 5 second callback timeout as a refusal and does not send', async () => {
    expect(ALLOWLIST_CALLBACK_TIMEOUT_MS).toBe(5_000);
    const { wallet, ledger, payouts } = harness({ timeoutMs: 20 });
    await fund(ledger, 'BTC', '2', 'seed-hang');
    await expect(wallet.submitWithdrawal(ready({ allowlistCallback: () => new Promise<string>(() => undefined) }))).rejects.toMatchObject({
      code: 'pay.wallet_allowlist',
    });
    expect(payouts).toHaveLength(0);
    expect(await available(wallet, 'BTC')).toBe('2');
  });
});

describe('WAL-0168 stored destination and cooling, not a typed address', () => {
  it('refuses a different address and posts no hold', async () => {
    const { wallet, ledger, payouts, posts } = harness();
    await fund(ledger, 'BTC', '2', 'seed-typed');
    const before = posts();
    await expect(wallet.submitWithdrawal(ready({ typedAddress: 'bc1qother' }))).rejects.toMatchObject({
      code: 'pay.wallet_typed_address',
    });
    expect(payouts).toHaveLength(0);
    expect(posts()).toBe(before);
    expect(await available(wallet, 'BTC')).toBe('2');
  });

  it('refuses inside a 24 hour cooling window', async () => {
    const { wallet, ledger, payouts } = harness({
      publish: publish({
        storedDestination: () => ({ ref: STORED, updatedAt: new Date('2026-10-17T12:00:00.000Z') }),
      }),
    });
    await fund(ledger, 'BTC', '2', 'seed-cool');
    await expect(wallet.submitWithdrawal(ready())).rejects.toMatchObject({ code: 'pay.wallet_cooling' });
    expect(payouts).toHaveLength(0);
  });
});

describe('WAL-0177 a disabled withdraw status leaves the hold', () => {
  it('refuses the new withdrawal and keeps the 0.5 BTC hold', async () => {
    const { wallet, ledger, store, payouts } = harness({
      publish: publish({ withdrawEnabled: () => false }),
    });
    await fund(ledger, 'BTC', '2', 'seed-off-status');
    await seedHold(store, ledger, '0.5', 'wd-half');
    await expect(wallet.submitWithdrawal(ready({ amount: parseAmount('0.1'), clientRef: 'next' }))).rejects.toMatchObject({
      code: 'pay.wallet_withdraw_disabled',
    });
    await expect(wallet.submitWithdrawal(ready({ amount: parseAmount('0.1'), clientRef: 'next-2' }))).rejects.toMatchObject({
      code: 'pay.wallet_withdraw_disabled',
    });
    expect(payouts).toHaveLength(0);
    expect((await store.getWithdrawal('wd-half'))?.holdAmount).toBe(parseAmount('0.5'));
    expect(formatAmount((await ledger.balance(withdrawalHoldAccount(USER, 'BTC', 'wd-half'))).amount)).toBe('0.5');
  });
});

describe('WAL-0186 a hidden or blocked withdraw feature posts no hold', () => {
  it('refuses withdrawal.create while the feature is hidden and still allows a read', async () => {
    const { wallet, ledger, store, payouts } = harness({
      publish: publish({ withdrawFeatureStatus: 'hidden' }),
    });
    await fund(ledger, 'BTC', '2', 'seed-hidden');
    await store.saveWithdrawal(sentRow());
    await expect(wallet.submitWithdrawal(ready())).rejects.toMatchObject({ code: 'pay.wallet_withdraw_unavailable' });
    await expect(wallet.submitWithdrawal(ready({ clientRef: 'again' }))).rejects.toMatchObject({
      code: 'pay.wallet_withdraw_unavailable',
    });
    expect(payouts).toHaveLength(0);
    expect(await available(wallet, 'BTC')).toBe('2');
    expect((await wallet.supportRead({ withdrawalId: 'wd-sent', ownerUserId: USER })).status).toBe('sent');
  });

  it('refuses the customer withdraw door on the service when the published status is blocked', async () => {
    const ledger = new MemoryLedger();
    const wallet = new WalletPay({
      ledger,
      store: new MemoryWalletStore(),
      publish: publish({ withdrawFeatureStatus: 'blocked' }),
      chainReader: { confirm: async () => 'down' },
      rail: { payout: async () => ({ ok: false }) },
      allowlist: { has: () => false },
      now: () => NOW,
    });
    const sql = (() => Promise.resolve([])) as unknown as Sql;
    const money = new UserMoneyService(sql, ledger, new RailRegistry([]), {
      operatorCreditRails: [],
      wallet,
    });
    await fund(ledger, 'USDT', '5', 'seed-door');
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
    expect(await available(wallet, 'USDT')).toBe('5');
  });
});

describe('WAL-0048 and WAL-0088 cancel before broadcast', () => {
  it('cancels a pending withdrawal, restores a hold once, and does not broadcast', async () => {
    const { wallet, ledger, store, payouts } = harness();
    await fund(ledger, 'BTC', '2', 'seed-cancel');
    await seedHold(store, ledger, '0.4', 'wd-cancel');
    const held = await store.getWithdrawal('wd-cancel');
    if (!held) throw new Error('missing hold');
    held.status = 'pending';
    held.attempts = [];
    await store.saveWithdrawal(held);
    const before = formatAmount((await ledger.balance(userAvailable(USER, 'BTC'))).amount);
    const cancelled = await wallet.cancelWithdrawal({ withdrawalId: 'wd-cancel', userId: USER });
    expect(cancelled.status).toBe('cancelled');
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'BTC'))).amount)).toBe(
      formatAmount(parseAmount(before) + parseAmount('0.4')),
    );
    const postsAfter = (await wallet.cancelWithdrawal({ withdrawalId: 'wd-cancel', userId: USER })).status;
    expect(postsAfter).toBe('cancelled');
    expect(formatAmount((await ledger.balance(withdrawalHoldAccount(USER, 'BTC', 'wd-cancel'))).amount)).toBe('0');
    expect(payouts).toHaveLength(0);
  });

  it('refuses cancel after send and when the rail result is unknown', async () => {
    const { wallet, store, ledger } = harness();
    await store.saveWithdrawal(sentRow());
    await expect(wallet.cancelWithdrawal({ withdrawalId: 'wd-sent', userId: USER })).rejects.toMatchObject({
      code: 'pay.wallet_cancel_refused',
    });
    await fund(ledger, 'BTC', '1', 'seed-unknown-cancel');
    await seedHold(store, ledger, '0.4', 'wd-unknown');
    const row = await store.getWithdrawal('wd-unknown');
    if (!row) throw new Error('missing');
    row.attempts = [{ outcome: 'requested', railRef: null }];
    await store.saveWithdrawal(row);
    await expect(wallet.cancelWithdrawal({ withdrawalId: 'wd-unknown', userId: USER })).rejects.toMatchObject({
      code: 'pay.wallet_cancel_refused',
    });
    expect(formatAmount((await ledger.balance(withdrawalHoldAccount(USER, 'BTC', 'wd-unknown'))).amount)).toBe('0.4');
  });
});

describe('WAL-0057 an admin credit of a sent withdrawal', () => {
  it('refuses a credit without the reverse recipe and a chain-return proof', async () => {
    const { wallet, store, ledger, posts, payouts } = harness();
    await fund(ledger, 'BTC', '1', 'seed-admin');
    await store.saveWithdrawal({ ...sentRow(), holdAmount: parseAmount('0.4') });
    await ledger.post(
      recipes.withdrawHold({
        userId: USER,
        assetId: 'BTC',
        amount: parseAmount('0.4'),
        rail: 'crypto-native',
        withdrawalId: 'wd-sent',
      }),
    );
    const before = await available(wallet, 'BTC');
    const mark = posts();
    await expect(wallet.adminCreditSent({ withdrawalId: 'wd-sent', reason: null, chainReturnProof: null })).rejects.toMatchObject({
      code: 'pay.wallet_sent_credit_refused',
    });
    expect(posts()).toBe(mark);
    expect(await available(wallet, 'BTC')).toBe(before);
    expect(payouts).toHaveLength(0);
    expect((await store.getWithdrawal('wd-sent'))?.status).toBe('sent');
  });

  it('posts withdrawReverse once when the reason and the chain-return proof are both present', async () => {
    const { wallet, store, ledger } = harness();
    await fund(ledger, 'BTC', '1', 'seed-admin-ok');
    await store.saveWithdrawal({ ...sentRow(), holdAmount: parseAmount('0.4') });
    await ledger.post(
      recipes.withdrawHold({
        userId: USER,
        assetId: 'BTC',
        amount: parseAmount('0.4'),
        rail: 'crypto-native',
        withdrawalId: 'wd-sent',
      }),
    );
    const before = await available(wallet, 'BTC');
    await wallet.adminCreditSent({
      withdrawalId: 'wd-sent',
      reason: 'chain returned the transfer',
      chainReturnProof: '0xreturn',
    });
    expect(await available(wallet, 'BTC')).toBe(formatAmount(parseAmount(before) + parseAmount('0.4')));
    await wallet.adminCreditSent({
      withdrawalId: 'wd-sent',
      reason: 'chain returned the transfer',
      chainReturnProof: '0xreturn',
    });
    expect(await available(wallet, 'BTC')).toBe(formatAmount(parseAmount(before) + parseAmount('0.4')));
    const tx = await ledger.getTxByKey('withdraw.reverse:wd-sent');
    expect(tx?.reason).toBe('withdraw.reversed');
  });
});

describe('WAL-0117 needs-info keeps the hold and stores only named fields', () => {
  it('does not settle, and refuses a field the owner schema does not name', async () => {
    const { wallet, store, ledger, posts } = harness();
    await fund(ledger, 'BTC', '1', 'seed-info');
    await seedHold(store, ledger, '0.4', 'wd-info');
    const mark = posts();
    const marked = await wallet.markNeedsInfo({ withdrawalId: 'wd-info', fields: { beneficiary_name: 'Ada' } });
    expect(marked.status).toBe('needs-info');
    expect(marked.holdAmount).toBe(parseAmount('0.4'));
    expect(posts()).toBe(mark);
    await wallet.markNeedsInfo({ withdrawalId: 'wd-info', fields: { beneficiary_name: 'Ada' } });
    expect(posts()).toBe(mark);
    await expect(wallet.settleWithdrawal('wd-info')).rejects.toMatchObject({ code: 'pay.wallet_needs_info' });
    await expect(wallet.markNeedsInfo({ withdrawalId: 'wd-info', fields: { passport_scan: 'no' } })).rejects.toMatchObject({
      code: 'pay.wallet_field_unnamed',
    });
    expect((await store.getWithdrawal('wd-info'))?.recipient.passport_scan).toBeUndefined();
    expect(formatAmount((await ledger.balance(withdrawalHoldAccount(USER, 'BTC', 'wd-info'))).amount)).toBe('0.4');
  });
});

describe('a passing withdrawal posts the shown fee once', () => {
  it('sends once for the same client ref', async () => {
    const { wallet, ledger, payouts } = harness();
    await fund(ledger, 'BTC', '2', 'seed-ok');
    const sent = await wallet.submitWithdrawal(ready());
    expect(sent.status).toBe('sent');
    expect(sent.fee).toBe(parseAmount('0.00021'));
    expect(sent.attempts).toEqual([{ outcome: 'accepted', railRef: '0xsent' }]);
    expect(payouts).toHaveLength(1);
    const again = await wallet.submitWithdrawal(ready());
    expect(again.id).toBe(sent.id);
    expect(payouts).toHaveLength(1);
    expect(await available(wallet, 'BTC')).toBe('1.6');
  });
});

function sentRow(): WalletWithdrawal {
  return {
    id: 'wd-sent',
    userId: USER,
    assetId: 'BTC',
    network: 'BTC',
    amount: parseAmount('0.4'),
    fee: parseAmount('0.00021'),
    clientRef: 'client-sent',
    destinationRef: STORED,
    status: 'sent',
    holdAmount: 0n,
    recipient: { beneficiary_name: 'Ada Lovelace' },
    attempts: [{ outcome: 'accepted', railRef: '0xabc' }],
    reversed: false,
  };
}

async function seedHold(store: WalletStore, ledger: MemoryLedger, amount: string, id: string) {
  const row: WalletWithdrawal = {
    id,
    userId: USER,
    assetId: 'BTC',
    network: 'BTC',
    amount: parseAmount(amount),
    fee: parseAmount('0.00021'),
    clientRef: `hold-${id}`,
    destinationRef: STORED,
    status: 'held',
    holdAmount: parseAmount(amount),
    recipient: {},
    attempts: [],
    reversed: false,
  };
  await ledger.post(
    recipes.withdrawHold({
      userId: USER,
      assetId: 'BTC',
      amount: parseAmount(amount),
      rail: 'crypto-native',
      withdrawalId: id,
    }),
  );
  await store.saveWithdrawal(row);
}
