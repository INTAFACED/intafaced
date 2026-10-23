import { describe, expect, it } from 'vitest';
import { personSendReview, personSendStepUp, type PersonSendQuote } from './person-send-terms';

const quote = (over: Partial<PersonSendQuote> = {}): PersonSendQuote => ({
  assetId: 'USDT',
  amount: '40',
  perTransferLimit: '1000',
  dailyLimit: '5000',
  spentToday: '25',
  fee: '0',
  feeBlocker: null,
  withinPerTransfer: true,
  withinDaily: true,
  ...over,
});
const ok = (data: PersonSendQuote) => ({ ok: true as const, data });
const refused = (code: string) => ({ ok: false as const, reason: 'error' as const, code, message: code });

describe('the review of a send to a person (J-bank-04 #3)', () => {
  it('shows the fee line and a total that is the sum of the lines, as exact strings, and what leaves the account', () => {
    const review = personSendReview(ok(quote({ amount: '40.000000000000000001', fee: '0.1' })), '40.000000000000000001', 'USDT');
    expect(review.rows).toEqual([
      ['Transfer fee', '0.1 USDT'],
      ['Fees in total', '0.1 USDT'],
      ['Taken from your account', '40.100000000000000001 USDT'],
      ['Left to send today after this', '4,934.999999999999999999 USDT'],
    ]);
  });
  it('leaves Confirm on for a published zero fee within both limits', () => {
    const review = personSendReview(ok(quote()), '40', 'USDT');
    expect(review.blocked).toBeNull();
    expect(review.rows[0]).toEqual(['Transfer fee', '0 USDT']);
  });
  it('turns Confirm off and names the missing fee when nothing is published for the asset', () => {
    const review = personSendReview(refused('bank.personal_transfer_terms_unset'), '40', 'BTC');
    expect(review.rows).toEqual([]);
    expect(review.blocked).toContain('No fee or sending limit is published for BTC');
    expect(review.blocked).toContain('bank.personal_transfer_terms_unset');
  });
  it('turns Confirm off for a fee the transfer cannot charge, then the single limit, then today’s', () => {
    const unwired = personSendReview(ok(quote({ fee: '1', feeBlocker: 'bank.personal_transfer_fee_unwired' })), '40', 'USDT');
    expect(unwired.blocked).toContain('bank.personal_transfer_fee_unwired');
    // Nothing would leave, so no "taken" figure stands beside the refusal.
    expect(unwired.rows.map(([label]) => label)).toEqual(['Transfer fee', 'Fees in total']);
    expect(personSendReview(ok(quote({ withinPerTransfer: false, withinDaily: false })), '40', 'USDT').blocked).toContain(
      '1,000 USDT limit',
    );
    expect(personSendReview(ok(quote({ spentToday: '4990', withinDaily: false })), '40', 'USDT').blocked).toContain('Only 10 USDT');
  });
  it('never shows a quote for another amount or asset, and says so when the read fails', () => {
    expect(personSendReview(ok(quote({ amount: '41' })), '40', 'USDT')).toMatchObject({ rows: [], blocked: expect.any(String) });
    expect(personSendReview(ok(quote({ assetId: 'USDC' })), '40', 'USDT').rows).toEqual([]);
    expect(personSendReview({ ok: false, reason: 'error', message: 'offline' }, '40', 'USDT').blocked).toContain('could not be read');
  });
  it('names any other refusal by the service’s own code', () => {
    expect(personSendReview(refused('bank.account_frozen'), '40', 'USDT').blocked).toContain('(bank.account_frozen)');
  });
});

describe('the step-up for a send to a person (J-bank-04 #4)', () => {
  const input = { transferId: 't-1', fromSpaceId: 'space-a', toUserId: 'user-b', amount: '40' };
  it('names exactly the strings the send carries, so identity and the bank hash the same bytes', () => {
    expect(personSendStepUp('USDT', input)).toEqual({
      scope: 'bank.step_up.transfers.toUser',
      purpose: 'transfers.toUser',
      target: 'user-b',
      amount: '40',
      fields: { transferId: 't-1', fromSpaceId: 'space-a', toUserId: 'user-b', assetId: 'USDT', amount: '40' },
    });
  });
  it('adds the note and reference only when the send has them', () => {
    expect(personSendStepUp('USDT', { ...input, note: 'Lunch', reference: 'INV-1' }).fields).toMatchObject({
      note: 'Lunch',
      reference: 'INV-1',
    });
    expect(Object.keys(personSendStepUp('USDT', { ...input, note: '' }).fields)).not.toContain('note');
  });
});
