import { describe, expect, it } from 'vitest';
import { cardSim, cardIssuerFor } from './issuer.js';
import { NOTHING_REPORTED } from './partner-terms.js';
import { answerTestCardPartnerRecord, TEST_CARD_PARTNER_RECORD_ID } from './test-card-partner-record.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const account = (owner: string) => ({ account: { venueId: TEST_CARD_PARTNER_RECORD_ID, owner, subAccount: null } });
const TERMS = { bearer: 'programme' as const, terms: 'TEST terms: the programme bears card fraud and lost chargebacks' };
const sim = (over = {}) => {
  const s = cardSim({ partner: { ...NOTHING_REPORTED, test: true, balances: { USDC: '120' }, ...over } });
  return { ...s, testRecord: s.testRecord! };
};

describe('the TEST card partner record read', () => {
  it('names itself, TEST', () => {
    const [status, body] = answerTestCardPartnerRecord(sim(), 'GET', '/venue', null);
    expect(status).toBe(200);
    expect(body).toMatchObject({ label: 'TEST', venue: { id: TEST_CARD_PARTNER_RECORD_ID } });
  });

  it("answers one cardholder's book as the partner keeps it: its credit once, its reversal, never another's", async () => {
    const s = sim();
    await s.provisionalCredit!({ requestId: 'c1', userId: ADA, assetId: 'USDC', amount: '50' });
    await s.provisionalCredit!({ requestId: 'c1', userId: ADA, assetId: 'USDC', amount: '50' });
    expect(answerTestCardPartnerRecord(s, 'POST', '/balances', account(ADA))).toEqual([
      200,
      { label: 'TEST', value: [{ asset: 'USDC', free: '170', locked: '0', total: '170' }] },
    ]);
    const [, credits] = answerTestCardPartnerRecord(s, 'POST', '/credits', account(ADA)) as [number, { value: { reversed: boolean }[] }];
    expect(credits.value).toHaveLength(1);
    expect(credits.value[0]).toMatchObject({ assetId: 'USDC', amount: '50', reversed: false });
    expect(answerTestCardPartnerRecord(s, 'POST', '/credits', account(BOB))).toEqual([200, { label: 'TEST', value: [] }]);
    expect((answerTestCardPartnerRecord(s, 'POST', '/balances', account(BOB))[1] as { value: { total: string }[] }).value[0]!.total).toBe(
      '120',
    );
    await s.settleProvisionalCredit!({ requestId: 'd1', creditRequestId: 'c1', settlement: 'reversed' });
    expect(
      (answerTestCardPartnerRecord(s, 'POST', '/credits', account(ADA))[1] as { value: { reversed: boolean }[] }).value[0]!.reversed,
    ).toBe(true);
    expect((answerTestCardPartnerRecord(s, 'POST', '/balances', account(ADA))[1] as { value: { total: string }[] }).value[0]!.total).toBe(
      '120',
    );
  });

  it('reports who bears a loss as its terms say, or null when it reports nothing', () => {
    expect(answerTestCardPartnerRecord(sim(), 'POST', '/terms', account(ADA))).toEqual([
      200,
      { label: 'TEST', value: { lossLiability: null } },
    ]);
    expect(answerTestCardPartnerRecord(sim({ lossLiability: TERMS }), 'POST', '/terms', account(ADA))).toEqual([
      200,
      { label: 'TEST', value: { lossLiability: TERMS } },
    ]);
  });

  it('refuses a wrong account, a sub-account, an unknown path and a wrong method', () => {
    const s = sim();
    expect(answerTestCardPartnerRecord(s, 'POST', '/balances', { account: { venueId: 'x', owner: ADA } })[0]).toBe(400);
    expect(answerTestCardPartnerRecord(s, 'POST', '/balances', { account: { venueId: TEST_CARD_PARTNER_RECORD_ID } })[0]).toBe(400);
    expect(answerTestCardPartnerRecord(s, 'POST', '/balances', { account: { ...account(ADA).account, subAccount: 'a' } })[0]).toBe(400);
    expect(answerTestCardPartnerRecord(s, 'POST', '/moves', account(ADA))[0]).toBe(404);
    expect(answerTestCardPartnerRecord(s, 'GET', '/credits', account(ADA))[0]).toBe(405);
  });

  it('is only on the simulator: no issuer and the simulator in a live posture keep no record', () => {
    expect(cardIssuerFor('none').testRecord).toBeUndefined();
    expect(cardIssuerFor('card-sim', { live: true }).testRecord).toBeUndefined();
  });
});
