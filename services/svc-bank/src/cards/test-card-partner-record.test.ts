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
  it('names itself, TEST', async () => {
    const [status, body] = await answerTestCardPartnerRecord(sim(), 'GET', '/venue', null);
    expect(status).toBe(200);
    expect(body).toMatchObject({ label: 'TEST', venue: { id: TEST_CARD_PARTNER_RECORD_ID } });
  });

  it("answers one cardholder's book as the partner keeps it: its credit once, its reversal, never another's", async () => {
    const s = sim();
    await s.provisionalCredit!({ requestId: 'c1', userId: ADA, assetId: 'USDC', amount: '50' });
    await s.provisionalCredit!({ requestId: 'c1', userId: ADA, assetId: 'USDC', amount: '50' });
    expect(await answerTestCardPartnerRecord(s, 'POST', '/balances', account(ADA))).toEqual([
      200,
      { label: 'TEST', value: [{ asset: 'USDC', free: '170', locked: '0', total: '170' }] },
    ]);
    const [, credits] = (await answerTestCardPartnerRecord(s, 'POST', '/credits', account(ADA))) as [
      number,
      { value: { reversed: boolean }[] },
    ];
    expect(credits.value).toHaveLength(1);
    expect(credits.value[0]).toMatchObject({ assetId: 'USDC', amount: '50', reversed: false });
    expect(await answerTestCardPartnerRecord(s, 'POST', '/credits', account(BOB))).toEqual([200, { label: 'TEST', value: [] }]);
    expect(
      ((await answerTestCardPartnerRecord(s, 'POST', '/balances', account(BOB)))[1] as { value: { total: string }[] }).value[0]!.total,
    ).toBe('120');
    await s.settleProvisionalCredit!({ requestId: 'd1', creditRequestId: 'c1', settlement: 'reversed' });
    expect(
      ((await answerTestCardPartnerRecord(s, 'POST', '/credits', account(ADA)))[1] as { value: { reversed: boolean }[] }).value[0]!
        .reversed,
    ).toBe(true);
    expect(
      ((await answerTestCardPartnerRecord(s, 'POST', '/balances', account(ADA)))[1] as { value: { total: string }[] }).value[0]!.total,
    ).toBe('120');
  });

  it('reports its terms as they are set, each null when it reports nothing', async () => {
    expect(await answerTestCardPartnerRecord(sim(), 'POST', '/terms', account(ADA))).toEqual([
      200,
      {
        label: 'TEST',
        value: {
          lossLiability: null,
          funder: null,
          reserve: null,
          programmeFigures: null,
          figuresAsOf: null,
          fundingAssetId: null,
          fundingOffers: null,
        },
      },
    ]);
    const reported = sim({
      lossLiability: TERMS,
      funder: 'TEST funder',
      reserve: { required: true, amount: '25000.00', assetId: 'USDC' },
      programmeFigures: { USDC: { held: '5', captured: '20' } },
      figuresAsOf: 'now',
      fundingAssetId: 'USDC',
      fundingOffers: { fund: true, defund: true, autoReload: false },
    });
    expect((await answerTestCardPartnerRecord(reported, 'POST', '/terms', account(BOB)))[1]).toEqual({
      label: 'TEST',
      value: {
        lossLiability: TERMS,
        funder: 'TEST funder',
        reserve: { required: true, amount: '25000.00', assetId: 'USDC' },
        programmeFigures: { USDC: { held: '5', captured: '20' } },
        figuresAsOf: 'now',
        fundingAssetId: 'USDC',
        fundingOffers: { fund: true, defund: true, autoReload: false },
      },
    });
  });

  it('lists each funding instruction it took once under its key, and none it refused', async () => {
    const s = sim({ fundingAssetId: 'USDC', fundingOffers: { fund: true, defund: false, autoReload: false } });
    const input = { requestId: 'f1', kind: 'fund' as const, assetId: 'USDC', amount: '1000', threshold: null };
    const first = await s.programmeFunding!(input);
    expect(await s.programmeFunding!(input)).toEqual(first);
    await expect(s.programmeFunding!({ ...input, requestId: 'f2', kind: 'defund' })).rejects.toThrow();
    expect((await answerTestCardPartnerRecord(s, 'POST', '/funding', account(ADA)))[1]).toEqual({
      label: 'TEST',
      value: [{ ...input, partnerRef: first.partnerRef }],
    });
  });

  it("lists the partner card's own held and captured per asset for one cardholder, none with no holds wired", async () => {
    const holds = {
      figures: async ({ assetId }: { userId: string; assetId: string }) => ({
        test: true,
        mode: null,
        assetId,
        available: '95',
        held: '5',
      }),
      captured: async ({ userId }: { userId: string; assetId: string }) => (userId === ADA ? '20' : '0'),
    };
    expect((await answerTestCardPartnerRecord({ ...sim(), holds }, 'POST', '/holds', account(ADA)))[1]).toEqual({
      label: 'TEST',
      value: [{ asset: 'USDC', held: '5', captured: '20' }],
    });
    expect((await answerTestCardPartnerRecord(sim(), 'POST', '/holds', account(ADA)))[1]).toEqual({ label: 'TEST', value: [] });
  });

  it('refuses a wrong account, a sub-account, an unknown path and a wrong method', async () => {
    const s = sim();
    expect((await answerTestCardPartnerRecord(s, 'POST', '/balances', { account: { venueId: 'x', owner: ADA } }))[0]).toBe(400);
    expect((await answerTestCardPartnerRecord(s, 'POST', '/balances', { account: { venueId: TEST_CARD_PARTNER_RECORD_ID } }))[0]).toBe(400);
    expect((await answerTestCardPartnerRecord(s, 'POST', '/balances', { account: { ...account(ADA).account, subAccount: 'a' } }))[0]).toBe(
      400,
    );
    expect((await answerTestCardPartnerRecord(s, 'POST', '/moves', account(ADA)))[0]).toBe(404);
    expect((await answerTestCardPartnerRecord(s, 'GET', '/credits', account(ADA)))[0]).toBe(405);
  });

  it('is only on the simulator: no issuer and the simulator in a live posture keep no record', () => {
    expect(cardIssuerFor('none').testRecord).toBeUndefined();
    expect(cardIssuerFor('card-sim', { live: true }).testRecord).toBeUndefined();
  });
});
