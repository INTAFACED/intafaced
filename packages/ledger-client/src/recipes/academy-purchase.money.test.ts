import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { houseFees } from '../accounts.js';
import { movesCustomerBalance } from '../custody-layer.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { IDEMPOTENCY_CONFLICT_CODE } from '../client.js';
import { InsufficientFundsError, InvalidEntryError } from '../types.js';
import {
  ACADEMY_PURCHASE_MODULE,
  academyPurchaseKey,
  academyRefundKey,
  type AcademyPurchaseInput,
  type AcademyPurchaseRefundInput,
} from './academy-purchase.js';
import { recipes } from './index.js';
import { ownFundsPlaceAccount, type OwnFundsPlace } from './own-funds.js';

/**
 * A paid Academy course bought from the buyer's own wallet into one of our own-funds places, and its staff refund
 * (J-academy-07). TEST amounts only: the real course price is the owner's number.
 */
const COURSE = 'perps-101';
const ALICE = '11111111-1111-4111-8111-1111111111a7';
const WALLET: OwnFundsPlace = { kind: 'treasury-wallet', walletId: 'base:ops' };
const PARTNER: OwnFundsPlace = { kind: 'partner-reserve', partnerId: 'test-partner' };
const TX = (c: string) => `0x${c.repeat(64)}`;

let ledger: MemoryLedger;
beforeEach(() => {
  ledger = new MemoryLedger();
});
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const revenue = () => houseFees(ACADEMY_PURCHASE_MODULE, 'USDC');
const place = (p: OwnFundsPlace = WALLET) => ownFundsPlaceAccount(p, 'USDC');

const buy = (amount = '10', over: Partial<AcademyPurchaseInput> = {}) =>
  recipes.academyPurchase({
    course: COURSE,
    userId: ALICE,
    n: 1n,
    assetId: 'USDC',
    amount: amt(amount),
    to: WALLET,
    paymentId: TX('a'),
    ...over,
  });

const refund = (amount = '10', over: Partial<AcademyPurchaseRefundInput> = {}) =>
  recipes.academyPurchaseRefund({
    course: COURSE,
    userId: ALICE,
    n: 1n,
    assetId: 'USDC',
    amount: amt(amount),
    from: WALLET,
    paymentId: TX('b'),
    ...over,
  });

const sum = (entries: readonly { direction: string; amount: bigint }[], dir: string) =>
  entries.filter((e) => e.direction === dir).reduce((a, e) => a + e.amount, 0n);

describe('academyPurchase', () => {
  it('posts revenue up and more of ours at the place, balanced, under the exact journey key', async () => {
    const post = buy();
    expect(post.idempotencyKey).toBe(`academy:purchase:${COURSE}:${ALICE}:1`);
    expect(post.idempotencyKey).toBe(academyPurchaseKey(COURSE, ALICE, 1n));
    expect(post.module).toBe('academy');
    expect(post.reason).toBe('academy.purchase.posted');
    expect(post.meta).toEqual({ course: COURSE, userId: ALICE, paymentId: TX('a'), to: place().ownerId });
    expect(sum(post.entries, 'debit')).toBe(sum(post.entries, 'credit'));
    await ledger.post(post);
    expect(await bal(revenue())).toBe('10');
    expect(await bal(place())).toBe('-10');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a second post on the same key is one post; the same key for another amount is refused', async () => {
    const first = await ledger.post(buy());
    const again = await ledger.post(buy());
    expect(again.id).toBe(first.id);
    expect(await bal(revenue())).toBe('10');
    expect(await bal(place())).toBe('-10');
    await expect(ledger.post(buy('11'))).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT_CODE });
    expect(await bal(revenue())).toBe('10');
  });

  it("the buyer's next purchase of the same course is a new key", async () => {
    await ledger.post(buy());
    await ledger.post(buy('10', { n: 2n, paymentId: TX('c') }));
    expect(await bal(revenue())).toBe('20');
  });
});

describe('academyPurchaseRefund', () => {
  it('reverses the purchase exactly: revenue and the place back to before', async () => {
    await ledger.post(buy());
    const post = refund();
    expect(post.idempotencyKey).toBe(`academy:refund:${COURSE}:${ALICE}:1`);
    expect(post.idempotencyKey).toBe(academyRefundKey(COURSE, ALICE, 1n));
    expect(post.reason).toBe('academy.purchase.refunded');
    expect(post.meta).toMatchObject({ purchaseKey: academyPurchaseKey(COURSE, ALICE, 1n), paymentId: TX('b') });
    expect(sum(post.entries, 'debit')).toBe(sum(post.entries, 'credit'));
    // Each leg is the purchase leg with its direction flipped.
    const p = buy()
      .entries.map((e) => `${e.account.ownerId}|${e.direction === 'debit' ? 'credit' : 'debit'}|${e.amount}`)
      .sort();
    expect(post.entries.map((e) => `${e.account.ownerId}|${e.direction}|${e.amount}`).sort()).toEqual(p);
    await ledger.post(post);
    await ledger.post(post);
    expect(await bal(revenue())).toBe('0');
    expect(await bal(place())).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses a refund with nothing bought, and the book is unchanged', async () => {
    await expect(ledger.post(refund())).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(revenue())).toBe('0');
    expect(await bal(place())).toBe('0');
  });

  it('refuses a refund above what the place holds of ours (balanceAllowed), even with revenue to cover it', async () => {
    await ledger.post(buy('10'));
    await ledger.post(buy('5', { n: 2n, to: PARTNER, paymentId: TX('c') }));
    await expect(ledger.post(refund('5.000001', { n: 2n, from: PARTNER }))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(revenue())).toBe('15');
    expect(await bal(place(PARTNER))).toBe('-5');
    await ledger.post(refund('5', { n: 2n, from: PARTNER }));
    expect(await bal(place(PARTNER))).toBe('0');
    expect(await bal(revenue())).toBe('10');
  });
});

describe('own accounts only', () => {
  it('no leg is a customer balance, and neither recipe is in the custody-layer inventory', () => {
    expect(movesCustomerBalance(buy().entries)).toBe(false);
    expect(movesCustomerBalance(refund().entries)).toBe(false);
    const inventory = JSON.parse(readFileSync(new URL('../../../../tooling/ci/custody-layer-inventory.json', import.meta.url), 'utf8')) as {
      customerBalanceRecipes: string[];
    };
    expect(inventory.customerBalanceRecipes).not.toContain('academyPurchase');
    expect(inventory.customerBalanceRecipes).not.toContain('academyPurchaseRefund');
  });
});

describe('every validation branch refuses', () => {
  const cases: [string, Partial<AcademyPurchaseInput>][] = [
    ['course with upper case', { course: 'Perps-101' }],
    ['course starting with a dash', { course: '-perps' }],
    ['course with a colon', { course: 'perps:101' }],
    ['course longer than 64', { course: 'a'.repeat(65) }],
    ['empty course', { course: '' }],
    ['userId not a UUID', { userId: 'alice' }],
    ['userId upper case', { userId: ALICE.toUpperCase() }],
    ['n zero', { n: 0n }],
    ['n negative', { n: -1n }],
    ['n not a bigint', { n: 1 as unknown as bigint }],
    ['assetId blank', { assetId: '  ' }],
    ['assetId padded', { assetId: ' USDC' }],
    ['amount zero', { amount: 0n }],
    ['amount negative', { amount: -1n }],
    ['amount a number', { amount: 10 as unknown as bigint }],
    ['paymentId too short', { paymentId: '0xabc' }],
    ['paymentId upper hex', { paymentId: `0x${'A'.repeat(64)}` }],
    ['paymentId no 0x', { paymentId: 'a'.repeat(66) }],
    ['place not ours', { to: { kind: 'treasury-wallet', walletId: 'Bad Id' } }],
  ];

  for (const [name, over] of cases) {
    it(`purchase refuses: ${name}`, () => {
      expect(() => buy('10', over)).toThrow(InvalidEntryError);
    });
    it(`refund refuses: ${name}`, () => {
      const { to, ...rest } = over;
      expect(() => refund('10', { ...rest, ...(to ? { from: to } : {}) })).toThrow(InvalidEntryError);
    });
  }

  it('refuses a key longer than 200 characters', () => {
    const huge = 10n ** 140n;
    expect(() => buy('10', { n: huge })).toThrow(/longer than 200/);
    expect(() => refund('10', { n: huge })).toThrow(/longer than 200/);
  });
});
