import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { parseBankAccountTerms } from '../onboarding/bank-account-terms.js';
import { PARTNER_PAYOUTS_OWNER, partnerPayoutsAccount } from './partner-bank.js';
import { testPartner } from './test-partner.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const DEST = { name: 'Ada Lovelace', accountRef: 'NL91ABNA0417164300' };
const DAY = 86_400_000;

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
  } catch (err) {
    return (err as BankError).code;
  }
  return null;
}

/** A person whose bank money the TEST partner holds, with `amount` USDT in their main balance. */
function funded(amount: string) {
  const partner = testPartner();
  partner.set(ADA, { custody: 'off' });
  if (amount !== '0') partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: parseAmount(amount) });
  return partner;
}

const heldAt = (partner: ReturnType<typeof testPartner>, owner: string) =>
  partner
    .record(owner)
    .accounts.filter((row) => row.account.assetId === 'USDT')
    .reduce((sum, row) => sum + row.amount, 0n);

describe('onboarding: the partner’s steps, with our identity case only where the partner accepts it (J-bank-17 #1)', () => {
  it('a verified person has the identity step done with our case; unverified, it stays open', async () => {
    const partner = funded('0');
    const verified = await partner.compliance.onboarding(ADA, 'basic');
    expect(verified.identityCase).toEqual({ tier: 'basic', accepted: true });
    expect(verified.steps.find((s) => s.id === 'identity')).toMatchObject({ status: 'done', doneWith: 'identity_case' });
    const unverified = await partner.compliance.onboarding(ADA, 'none');
    expect(unverified.steps.find((s) => s.id === 'identity')).toMatchObject({ status: 'open', doneWith: null });
  });

  it('a partner that does not accept our case asks for its own check, whatever our tier', async () => {
    const partner = funded('0');
    partner.set(ADA, { identityCase: 'not_accepted' });
    const now = await partner.compliance.onboarding(ADA, 'full');
    expect(now.identityCase.accepted).toBe(false);
    expect(now.steps.find((s) => s.id === 'identity')).toMatchObject({ status: 'open', doneWith: null });
    expect(now.complete).toBe(false);
  });

  it('an open information request keeps onboarding open until it is answered', async () => {
    const partner = funded('0');
    partner.compliance.openRequest(ADA, 'req-1', 14);
    expect((await partner.compliance.onboarding(ADA, 'basic')).complete).toBe(false);
    await partner.compliance.answerRequest(ADA, 'req-1', { name: 'a.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF') });
    expect((await partner.compliance.onboarding(ADA, 'basic')).complete).toBe(true);
  });
});

describe('an information request moves to under review once (J-bank-17 #2)', () => {
  it('a second answer refuses and the first file stands', async () => {
    const partner = funded('0');
    partner.compliance.openRequest(ADA, 'req-1', 14);
    const first = await partner.compliance.answerRequest(ADA, 'req-1', {
      name: 'a.pdf',
      type: 'application/pdf',
      bytes: Buffer.from('one'),
    });
    expect(first.status).toBe('under_review');
    expect(
      await codeOf(() =>
        partner.compliance.answerRequest(ADA, 'req-1', { name: 'b.pdf', type: 'application/pdf', bytes: Buffer.from('two') }),
      ),
    ).toBe('bank.info_request_not_open');
    const [row] = await partner.compliance.requests(ADA);
    expect(row!.file!.name).toBe('a.pdf');
    expect(row!.file!.size).toBe(3);
  });

  it('a request past its deadline takes no answer; an unknown one is not found', async () => {
    const partner = funded('0');
    const opened = partner.compliance.openRequest(ADA, 'req-1', 1);
    const late = new Date(opened.dueAt.getTime() + 1);
    expect(
      await codeOf(() =>
        partner.compliance.answerRequest(ADA, 'req-1', { name: 'a.pdf', type: 'application/pdf', bytes: Buffer.from('x') }, late),
      ),
    ).toBe('bank.info_request_past_deadline');
    expect(
      await codeOf(() =>
        partner.compliance.answerRequest(ADA, 'nope', { name: 'a.pdf', type: 'application/pdf', bytes: Buffer.from('x') }),
      ),
    ).toBe('bank.info_request_not_found');
  });
});

describe('a periodic review shows its due date and the effect of missing it (J-bank-17 #4)', () => {
  it('is answered once', async () => {
    const partner = funded('0');
    const review = partner.compliance.openReview(ADA, 'rev-1', 30);
    expect(review.missedEffect).toMatch(/^TEST: /);
    expect(Math.round((review.dueAt.getTime() - Date.now()) / DAY)).toBe(30);
    expect((await partner.compliance.answerReview(ADA, 'rev-1', { stillAccurate: true, note: null })).status).toBe('answered');
    expect(await codeOf(() => partner.compliance.answerReview(ADA, 'rev-1', { stillAccurate: true, note: null }))).toBe(
      'bank.review_not_open',
    );
  });
});

describe('closure with a balance (J-bank-17 #5): restricted while pending, a destination required, closed once paid out', () => {
  it('a balance with no destination refuses, and nothing changes', async () => {
    const partner = funded('25');
    expect(await codeOf(() => partner.compliance.requestClosure(ADA, 'close-1', null))).toBe('bank.closure_destination_required');
    expect((await partner.compliance.closure(ADA)).state).toBe('open');
  });

  it('a legal hold refuses closure, and a hold placed while pending holds the payout', async () => {
    const partner = funded('25');
    partner.set(ADA, { legalHold: 'held' });
    expect(await codeOf(() => partner.compliance.requestClosure(ADA, 'close-1', DEST))).toBe('bank.closure_legal_hold');
    partner.set(ADA, { legalHold: 'none' });
    await partner.compliance.requestClosure(ADA, 'close-1', DEST);
    partner.set(ADA, { legalHold: 'held' });
    expect(await codeOf(() => partner.compliance.reportPaidOut(ADA))).toBe('bank.closure_legal_hold');
    expect(heldAt(partner, ADA)).toBe(parseAmount('25'));
    expect((await partner.compliance.closure(ADA)).state).toBe('pending');
  });

  it('pending restricts every move and pay-in; the payout moves the whole balance to the partner once, then it is closed', async () => {
    const partner = funded('25');
    const pending = await partner.compliance.requestClosure(ADA, 'close-1', DEST);
    expect(pending.state).toBe('pending');
    expect(pending.balances).toEqual([{ assetId: 'USDT', spaceId: null, amount: parseAmount('25') }]);
    // Restricted: neither a move out nor a pay-in is made.
    expect(
      await codeOf(() =>
        partner.bank.move({
          key: 'test-spend:x',
          from: { userId: ADA, assetId: 'USDT', spaceId: null },
          to: partnerPayoutsAccount('USDT'),
          amount: 1n,
        }),
      ),
    ).toBe('bank.account_restricted');
    expect(await codeOf(async () => partner.fund(ADA, { fundId: 'fund-ada-2', assetId: 'USDT', amount: parseAmount('1') }))).toBe(
      'bank.account_restricted',
    );
    // A second request while pending refuses; the same id answers with the same closure.
    expect(await codeOf(() => partner.compliance.requestClosure(ADA, 'close-2', DEST))).toBe('bank.closure_pending');
    expect((await partner.compliance.requestClosure(ADA, 'close-1', DEST)).id).toBe('close-1');
    expect(await codeOf(() => partner.compliance.requestClosure(ADA, 'close-1', { ...DEST, accountRef: 'DE00000000000000' }))).toBe(
      'bank.closure_conflict',
    );

    const before = heldAt(partner, PARTNER_PAYOUTS_OWNER);
    const closed = await partner.compliance.reportPaidOut(ADA);
    expect(closed.state).toBe('closed');
    expect(closed.payoutMoveIds).toHaveLength(1);
    // Invariant: what left the person is exactly what reached the partner's payouts account, and the person holds 0.
    expect(heldAt(partner, ADA)).toBe(0n);
    expect(heldAt(partner, PARTNER_PAYOUTS_OWNER) - before).toBe(parseAmount('25'));
    expect(await codeOf(() => partner.compliance.reportPaidOut(ADA))).toBe('bank.closure_not_found');
  });

  it('a payout whose reply is lost is retried under the same key and pays once (whose funds are stranded? none)', async () => {
    const partner = funded('25');
    await partner.compliance.requestClosure(ADA, 'close-1', DEST);
    partner.set(ADA, { nextReply: 'lost' });
    expect(await codeOf(() => partner.compliance.reportPaidOut(ADA))).toBe('bank.partner_reply_lost');
    expect((await partner.compliance.closure(ADA)).state).toBe('pending');
    const closed = await partner.compliance.reportPaidOut(ADA);
    expect(closed.state).toBe('closed');
    expect(heldAt(partner, ADA)).toBe(0n);
    expect(partner.record(ADA).moves.filter((m) => m.key.startsWith('bank.closure.payout:'))).toHaveLength(1);
  });

  it('a partner whose figures are not known cannot close the account', async () => {
    const partner = funded('25');
    partner.set(ADA, { figures: 'unknown' });
    expect(await codeOf(() => partner.compliance.requestClosure(ADA, 'close-1', DEST))).toBe('bank.partner_unavailable');
  });

  it('an empty account closes at once with no destination', async () => {
    const partner = funded('0');
    const closed = await partner.compliance.requestClosure(ADA, 'close-1', null);
    expect(closed.state).toBe('closed');
    expect(await codeOf(() => partner.compliance.requestClosure(ADA, 'close-2', null))).toBe('bank.account_closed');
  });
});

describe('reopen within the owner’s window; data-rights requests (J-bank-17 #6)', () => {
  it('reopens inside the window and lifts the restriction; after it, refuses', async () => {
    const partner = funded('0');
    const closed = await partner.compliance.requestClosure(ADA, 'close-1', null);
    expect(await codeOf(() => partner.compliance.reopen(ADA, 30, new Date(closed.closedAt!.getTime() + 30 * DAY + 1)))).toBe(
      'bank.reopen_window_passed',
    );
    const reopened = await partner.compliance.reopen(ADA, 30);
    expect(reopened.state).toBe('reopened');
    expect((await partner.compliance.closure(ADA)).state).toBe('open');
    partner.fund(ADA, { fundId: 'fund-ada-3', assetId: 'USDT', amount: parseAmount('1') });
    expect(await codeOf(() => partner.compliance.reopen(ADA, 30))).toBe('bank.account_not_closed');
  });

  it('a data request is recorded once per id with the partner’s reference', async () => {
    const partner = funded('0');
    const first = await partner.compliance.requestData(ADA, 'data-1', 'access');
    expect(first.partnerRef).toMatch(/^test-partner-data-/);
    expect((await partner.compliance.requestData(ADA, 'data-1', 'access')).partnerRef).toBe(first.partnerRef);
    expect(await codeOf(() => partner.compliance.requestData(ADA, 'data-1', 'portability'))).toBe('bank.data_request_conflict');
  });
});

describe('the owner’s values for a bank account have no default', () => {
  it('blank or not in shape is null', () => {
    expect(parseBankAccountTerms({})).toEqual({ ownerRequirements: null, upload: null, reopenWindowDays: null });
    expect(parseBankAccountTerms({ onboardingRequirements: '[]', infoRequestUpload: '{}', reopenWindowDays: '0' })).toEqual({
      ownerRequirements: null,
      upload: null,
      reopenWindowDays: null,
    });
    expect(
      parseBankAccountTerms({
        onboardingRequirements: '["TEST: a"]',
        infoRequestUpload: '{"allowedTypes":["application/pdf"],"maxBytes":10}',
        reopenWindowDays: '30',
      }),
    ).toEqual({ ownerRequirements: ['TEST: a'], upload: { allowedTypes: ['application/pdf'], maxBytes: 10 }, reopenWindowDays: 30 });
  });
});
