import { describe, expect, it } from 'vitest';
import {
  InsufficientFundsError,
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  railBoundary,
  recipes,
  subAccountAvailable,
  userAvailable,
  type AccountRef,
  type PostRequest,
} from '@intafaced/ledger-client';
import { RECIPE_REQUIRED_CODE, assertKnownRecipePost, recipeCandidates } from './recipe-gate.js';
import { LEDGER_POST_ALLOWLIST } from './caller-allowlist.js';

/**
 * LG-bank-business-debit-01 (D-149): a business space is a sub-account, so a
 * business bill payment is the same `bankTransfer` the personal bill path posts
 * (`services/svc-bank/src/personal-pay/post.ts` postToRail / reverseFromRail),
 * with a sub-account source. No new recipe. This file proves the gate takes
 * those shapes and that locks are never a source.
 */

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BUSINESS_SPACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_SPACE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RAIL = 'bank-bills';

function toWire(req: PostRequest) {
  return {
    module: req.module,
    reason: req.reason,
    entries: req.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
  };
}

const toRail = (from: AccountRef) =>
  recipes.bankTransfer({
    transferId: 'bill-1',
    occurrence: 0,
    from,
    to: railBoundary(RAIL, from.assetId),
    amount: amt('25'),
    kind: 'manual',
    keySpace: 'rail',
  });

const fromRail = (to: AccountRef) =>
  recipes.bankTransfer({
    transferId: 'bill-1',
    occurrence: 1,
    from: railBoundary(RAIL, to.assetId),
    to,
    amount: amt('25'),
    kind: 'manual',
    keySpace: 'rail',
  });

describe('business-space debit through bankTransfer (D-149)', () => {
  const business = subAccountAvailable(BUSINESS_SPACE, 'USDT');

  it('accepts a business space paying another space or a person', () => {
    for (const to of [subAccountAvailable(OTHER_SPACE, 'USDT'), userAvailable(USER2, 'USDT')]) {
      const post = recipes.bankTransfer({ transferId: 'b-1', occurrence: 0, from: business, to, amount: amt('10'), kind: 'manual' });
      expect(recipeCandidates(toWire(post))).toContain('bankTransfer');
    }
  });

  it('accepts a business space paying the bill rail, the same shape as a personal bill', () => {
    expect(recipeCandidates(toWire(toRail(business)))).toContain('bankTransfer');
    expect(recipeCandidates(toWire(toRail(userAvailable(USER, 'USDT'))))).toContain('bankTransfer');
  });

  it('accepts the rail returning a bill payment to the business space', () => {
    expect(recipeCandidates(toWire(fromRail(business)))).toContain('bankTransfer');
    expect(recipeCandidates(toWire(fromRail(userAvailable(USER, 'USDT'))))).toContain('bankTransfer');
  });

  it('refuses a hold, escrow or stake account as the source at the recipe', () => {
    for (const kind of ['hold', 'escrow', 'stake'] as const) {
      const locked: AccountRef = { ...business, kind, purpose: 'bill:1' } as AccountRef;
      expect(() => toRail(locked)).toThrow(/available accounts only/);
    }
  });

  it('refuses a business debit that would take the space below zero, and leaves a sibling space untouched', async () => {
    const ledger = new MemoryLedger();
    const sibling = subAccountAvailable(OTHER_SPACE, 'USDT');
    await ledger.post(
      recipes.bankTransfer({
        transferId: 'seed',
        occurrence: 0,
        from: railBoundary(RAIL, 'USDT'),
        to: sibling,
        amount: amt('100'),
        kind: 'manual',
        keySpace: 'rail',
      }),
    );
    await expect(ledger.post(toRail(business))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(formatAmount((await ledger.balance(sibling)).amount)).toBe('100');
    expect(formatAmount((await ledger.balance(business)).amount)).toBe('0');
  });

  it('refuses a business debit dressed as another recipe at the gate', () => {
    const post = toWire(toRail(business));
    expect(() => assertKnownRecipePost({ ...post, reason: 'bank.bill.business' })).toThrow(
      expect.objectContaining({ code: RECIPE_REQUIRED_CODE }),
    );
  });

  it('is granted to svc-bank only, under module bank', () => {
    expect(LEDGER_POST_ALLOWLIST['svc-bank'].bankTransfer).toMatchObject({ module: 'bank' });
    for (const [service, grants] of Object.entries(LEDGER_POST_ALLOWLIST)) {
      if (service !== 'svc-bank') expect((grants as Record<string, unknown>).bankTransfer, service).toBeUndefined();
    }
  });
});
