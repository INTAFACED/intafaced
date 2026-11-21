import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { partnerPayoutsAccount } from './partner-bank.js';
import { testPartner } from './test-partner.js';
import { TEST_PARTNER_DD_BLOCKED } from './test-partner-direct-debits.js';
import { directDebitMandatesView } from '../ops/direct-debit-mandates.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const main = { userId: ADA, assetId: 'USDT', spaceId: null };
const collect = (p: ReturnType<typeof testPartner>, mandateId: string, collectionId: string, amount: string) =>
  p.bank.move({
    key: `bank.dd.collection:${mandateId}:${collectionId}`,
    from: main,
    to: partnerPayoutsAccount('USDT'),
    amount: parseAmount(amount),
  });
const held = (p: ReturnType<typeof testPartner>) => p.record(ADA).accounts.find((a) => a.account.spaceId === null)?.amount;

describe("the TEST partner's direct debit book (J-bank-28 #4)", () => {
  it('knows a mandate from its setup, and reports its block', async () => {
    const p = testPartner();
    await p.directDebits.setUp!(ADA, 'MD-1');
    await p.directDebits.block(ADA, 'MD-2');
    const r = p.directDebitReport();
    expect(r.mandates.map((m) => [m.mandateId, m.state])).toEqual([
      ['MD-1', 'active'],
      ['MD-2', 'blocked'],
    ]);
    expect(r.mandates[1]!.blockedAt).toBeInstanceOf(Date);
  });

  it('records a refusal only when asked for a collection on a blocked mandate, once per collection', async () => {
    const p = testPartner();
    await p.directDebits.block(ADA, 'MD-1');
    await p.directDebits.mandate(ADA, 'MD-1');
    expect(p.directDebitReport().failures).toEqual([]);
    await p.directDebits.mandate(ADA, 'MD-1', 'C-1');
    await p.directDebits.mandate(ADA, 'MD-1', 'C-1');
    expect(p.directDebitReport().failures.map((f) => [f.collectionId, f.code])).toEqual([['C-1', TEST_PARTNER_DD_BLOCKED]]);
  });

  it('records a collection it refuses for want of money, and nothing moves', async () => {
    const p = testPartner();
    p.fund(ADA, { fundId: 'f1', assetId: 'USDT', amount: parseAmount('4') });
    await expect(collect(p, 'MD-1', 'C-9', '10')).rejects.toMatchObject({ code: 'bank.partner_insufficient_funds' });
    expect(held(p)).toBe(parseAmount('4'));
    expect(p.directDebitReport().failures.map((f) => [f.mandateId, f.collectionId, f.code])).toEqual([
      ['MD-1', 'C-9', 'bank.partner_insufficient_funds'],
    ]);
  });

  it('refunds a collected debit once: the balance rises by the collection exactly, and asking again changes nothing', async () => {
    const p = testPartner();
    p.fund(ADA, { fundId: 'f1', assetId: 'USDT', amount: parseAmount('20') });
    await collect(p, 'MD-1', 'C-1', '5');
    expect(held(p)).toBe(parseAmount('15'));
    const first = p.refundDirectDebit(ADA, 'MD-1', 'C-1');
    expect(held(p)).toBe(parseAmount('20'));
    const again = p.refundDirectDebit(ADA, 'MD-1', 'C-1');
    expect(again).toEqual(first);
    expect(held(p)).toBe(parseAmount('20'));
    expect(first).toMatchObject({ amount: parseAmount('5'), assetId: 'USDT' });
    // The partner's book: one collection out and one refund back, nothing else.
    expect(
      p
        .record(ADA)
        .moves.map((m) => m.key)
        .filter((k) => k.startsWith('bank.dd.')),
    ).toEqual(['bank.dd.collection:MD-1:C-1', 'bank.dd.refund:MD-1:C-1']);
    expect(p.directDebitReport().refunds).toHaveLength(1);
  });

  it('refuses a refund of a debit it never collected, or of someone else’s, and nothing moves', () => {
    const p = testPartner();
    p.fund(ADA, { fundId: 'f1', assetId: 'USDT', amount: parseAmount('20') });
    expect(() => p.refundDirectDebit(ADA, 'MD-1', 'C-404')).toThrow(expect.objectContaining({ code: 'bank.dd_refund_not_collected' }));
    expect(held(p)).toBe(parseAmount('20'));
    expect(p.directDebitReport().refunds).toEqual([]);
  });

  it('the desk view: mandates with their refunds and failures, failures counted by reason, details only for the right person', async () => {
    const p = testPartner();
    p.fund(ADA, { fundId: 'f1', assetId: 'USDT', amount: parseAmount('20') });
    await p.directDebits.setUp!(ADA, 'MD-1');
    await collect(p, 'MD-1', 'C-1', '5');
    p.refundDirectDebit(ADA, 'MD-1', 'C-1');
    await p.directDebits.block(ADA, 'MD-2');
    await p.directDebits.mandate(ADA, 'MD-2', 'C-2');
    await expect(collect(p, 'MD-3', 'C-3', '100')).rejects.toBeTruthy();
    const details = new Map([
      ['MD-1', { userId: ADA, creditorName: 'TEST Gym', reference: 'GYM 1', assetId: 'USDT' }],
      ['MD-2', { userId: 'someone-else', creditorName: 'Not theirs', reference: 'X', assetId: 'USDT' }],
    ]);
    const view = directDebitMandatesView(p.directDebitReport(), details).partner!;
    const by = (id: string) => view.mandates.find((m) => m.mandateId === id)!;
    expect(by('MD-1')).toMatchObject({ state: 'active', creditorName: 'TEST Gym', refunds: [{ collectionId: 'C-1', amount: '5' }] });
    expect(by('MD-2')).toMatchObject({
      state: 'blocked',
      creditorName: null,
      failures: [{ collectionId: 'C-2', code: TEST_PARTNER_DD_BLOCKED }],
    });
    expect(by('MD-3').failures).toEqual([expect.objectContaining({ code: 'bank.partner_insufficient_funds' })]);
    expect(view.failuresByReason).toEqual([
      { code: 'bank.partner_insufficient_funds', count: 1 },
      { code: TEST_PARTNER_DD_BLOCKED, count: 1 },
    ]);
    expect(view.refundCount).toBe(1);
  });

  it('with no partner the desk view is no data', () => {
    expect(directDebitMandatesView(null, new Map())).toEqual({ partner: null });
  });
});
