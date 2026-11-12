import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { paidByFor } from './partner-purchases.js';
import { TEST_PURCHASE_HOLD_DAYS, testPartner, testPartnerPurchases } from './test-partner.js';
import { partnerPayoutsAccount } from './partner-bank.js';

// J-wallet-01 #3: a purchase through the TEST partner is credited at the partner once per key, the partner holds it back
// until its release time, and what it holds back can't leave the balance until then.
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const KEY = 'deposit:payin-sim:add-money:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const units = (d: string) => parseAmount(d);

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return (err as BankError).code;
  }
  return null;
}

describe('a purchase through the TEST partner', () => {
  it('is credited once per key to the main balance, held back in whole until its TEST release time', async () => {
    const partner = testPartner();
    const before = Date.now();
    const first = await partner.purchases.credit(ADA, { key: KEY, assetId: 'USDT', amount: units('20'), paidBy: 'bank_pull' });
    const again = await partner.purchases.credit(ADA, { key: KEY, assetId: 'USDT', amount: units('20'), paidBy: 'bank_pull' });
    expect(again).toEqual(first);
    expect((await partner.bank.balance({ userId: ADA, assetId: 'USDT', spaceId: null })).amount).toBe(units('20'));
    expect(first.hold).toMatchObject({ purchaseKey: KEY, assetId: 'USDT', amount: units('20'), paidBy: 'bank_pull' });
    const days = TEST_PURCHASE_HOLD_DAYS.bank_pull * 86_400_000;
    expect(first.hold!.releaseAt.getTime()).toBeGreaterThanOrEqual(before + days);
    expect(first.hold!.releaseAt.getTime()).toBeLessThanOrEqual(Date.now() + days);
    const report = await partner.purchases.holds(ADA);
    expect(report).toMatchObject({ reported: true, label: 'TEST partner bank', released: [] });
    expect(report.reported && report.holds).toEqual([first.hold]);
    // One person's purchase never shows on another's.
    expect(await partner.purchases.holds(BOB)).toMatchObject({ reported: true, holds: [], released: [] });
  });

  it('refuses another purchase under the same key, and an amount of zero, crediting nothing', async () => {
    const partner = testPartner();
    await partner.purchases.credit(ADA, { key: KEY, assetId: 'USDT', amount: units('20'), paidBy: 'card' });
    expect(await codeOf(partner.purchases.credit(ADA, { key: KEY, assetId: 'USDT', amount: units('21'), paidBy: 'card' }))).toBe(
      'bank.partner_move_conflict',
    );
    expect(await codeOf(partner.purchases.credit(ADA, { key: `${KEY}-2`, assetId: 'USDT', amount: 0n, paidBy: 'card' }))).toBe(
      'bank.partner_amount_invalid',
    );
    expect((await partner.bank.balance({ userId: ADA, assetId: 'USDT', spaceId: null })).amount).toBe(units('20'));
  });

  it('refuses while the partner is down, crediting nothing', async () => {
    const partner = testPartner();
    partner.set(ADA, { down: true });
    expect(await codeOf(partner.purchases.credit(ADA, { key: KEY, assetId: 'USDT', amount: units('5'), paidBy: 'card' }))).toBe(
      'bank.partner_unavailable',
    );
    expect(await codeOf(partner.purchases.holds(ADA))).toBe('bank.partner_unavailable');
    partner.set(ADA, { down: false });
    expect((await partner.bank.balance({ userId: ADA, assetId: 'USDT', spaceId: null })).amount).toBe(0n);
  });

  it('keeps what it holds back in the balance: only the rest can leave until the release, then all of it', async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-50', assetId: 'USDT', amount: units('50') });
    await partner.purchases.credit(ADA, { key: KEY, assetId: 'USDT', amount: units('20'), paidBy: 'card' });
    const from = { userId: ADA, assetId: 'USDT', spaceId: null };
    expect(
      await codeOf(partner.bank.move({ key: 'payout:1', from, to: partnerPayoutsAccount('USDT'), amount: units('50.000000000000000001') })),
    ).toBe('bank.partner_insufficient_funds');
    await partner.bank.move({ key: 'payout:2', from, to: partnerPayoutsAccount('USDT'), amount: units('50') });
    expect((await partner.bank.balance(from)).amount).toBe(units('20'));
    expect(await codeOf(partner.bank.move({ key: 'payout:3', from, to: partnerPayoutsAccount('USDT'), amount: units('1') }))).toBe(
      'bank.partner_insufficient_funds',
    );
    partner.set(ADA, { purchaseHold: 'expired' });
    await partner.bank.move({ key: 'payout:4', from, to: partnerPayoutsAccount('USDT'), amount: units('20') });
    expect((await partner.bank.balance(from)).amount).toBe(0n);
  });

  it('releases a hold once, listed with when it was released, on every read after', async () => {
    const partner = testPartner();
    const { hold } = await partner.purchases.credit(ADA, { key: KEY, assetId: 'USDT', amount: units('20'), paidBy: 'card' });
    partner.set(ADA, { purchaseHold: 'expired' });
    const first = await partner.purchases.holds(ADA);
    const second = await partner.purchases.holds(ADA);
    if (!first.reported || !second.reported) throw new Error('the TEST partner reports its holds');
    expect(first.holds).toEqual([]);
    expect(first.released).toHaveLength(1);
    expect(first.released[0]).toMatchObject({ ...hold, releasedAt: expect.any(Date) });
    expect(second.released).toEqual(first.released);
  });

  it('says it does not report its holds, rather than reporting none', async () => {
    const partner = testPartner();
    await partner.purchases.credit(ADA, { key: KEY, assetId: 'USDT', amount: units('20'), paidBy: 'card' });
    partner.set(ADA, { purchaseHolds: 'not_reported' });
    expect(await partner.purchases.holds(ADA)).toEqual({ label: 'TEST partner bank', reported: false });
  });

  it('is the partner only for a person whose money it holds', () => {
    const partner = testPartner();
    const custody = testPartnerPurchases(partner);
    expect(custody.purchasesFor(ADA)).toBeNull();
    partner.set(ADA, { custody: 'off' });
    expect(custody.purchasesFor(ADA)).toBe(partner.purchases);
    expect(custody.purchasesFor(BOB)).toBeNull();
    expect(testPartnerPurchases(null).purchasesFor(ADA)).toBeNull();
  });

  it('is paid by card for a card or wallet pay, by a bank pull for pay by bank, and a bank transfer is no purchase', () => {
    expect(paidByFor('card')).toBe('card');
    expect(paidByFor('wallet_pay')).toBe('card');
    expect(paidByFor('pay_by_bank')).toBe('bank_pull');
    expect(paidByFor('bank_transfer')).toBeNull();
  });
});
