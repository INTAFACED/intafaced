import { parseAmount as amt } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { PARTNER_FEES_OWNER, PARTNER_PAYOUTS_OWNER, custodialOnly } from '../partner/partner-bank.js';
import { TEST_PARTNER_DAILY_SEND, TEST_PARTNER_SEND_FEE, testPartner, testPartnerCustody } from '../partner/test-partner.js';
import type { LedgerHistory } from './ledger-history.js';
import { SpendAnalytics } from './spend.js';

const ADA = 'ada-spend';
const BOB = 'bob-spend';
const main = (userId: string) => ({ userId, assetId: 'USDT', spaceId: null });
const noLedger: LedgerHistory = {
  entriesFor: () => {
    throw new Error('a partner-held person is never read from the ledger');
  },
};
const noSpaces = { namedSpaces: () => Promise.reject(new Error('not read')) } as never;
const wholeDay = () => ({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) });

function held() {
  const partner = testPartner();
  partner.set(ADA, { custody: 'off' });
  partner.fund(ADA, { fundId: 'spend-fund-1', assetId: 'USDT', amount: amt('200') });
  return partner;
}

describe('spend for a person the partner holds money for (J-bank-16 #4 #5)', () => {
  it("folds the partner's record: a pay-in is money in and not outflow, a send is transfers, each named out", async () => {
    const partner = held();
    await partner.bank.move({ key: 'k-send', from: main(ADA), to: main(BOB), amount: amt('80') });
    await partner.bank.move({ key: 'k-out', from: main(ADA), to: main(PARTNER_PAYOUTS_OWNER), amount: amt('10') });
    await partner.bank.move({ key: 'k-fee', from: main(ADA), to: main(PARTNER_FEES_OWNER), amount: amt('5') });
    const s = await new SpendAnalytics(noSpaces, noLedger, testPartnerCustody(partner)).spendSummary({
      userId: ADA,
      assetId: 'USDT',
      range: wholeDay(),
    });
    expect(s).toMatchObject({ totalOutflow: '95', totalInflow: '200', net: '105', movements: 4 });
    expect(s.outflowByCategory).toMatchObject({ transfers: '80', withdrawals: '10', fees: '5', deposits: '200' });
  });

  it("a move between the person's own spaces is not spending", async () => {
    const partner = held();
    await partner.bank.move({ key: 'k-own', from: main(ADA), to: { userId: ADA, assetId: 'USDT', spaceId: 'trip' }, amount: amt('20') });
    const s = await new SpendAnalytics(noSpaces, noLedger, testPartnerCustody(partner)).spendSummary({
      userId: ADA,
      assetId: 'USDT',
      range: wholeDay(),
    });
    expect(s).toMatchObject({ totalOutflow: '0', totalInflow: '200', movements: 1 });
  });

  it('counts a line only inside the range', async () => {
    const partner = held();
    const earlier = { from: new Date(Date.now() - 7_200_000), to: new Date(Date.now() - 3_600_000) };
    const s = await new SpendAnalytics(noSpaces, noLedger, testPartnerCustody(partner)).spendSummary({
      userId: ADA,
      assetId: 'USDT',
      range: earlier,
    });
    expect(s).toMatchObject({ totalInflow: '0', movements: 0 });
  });

  it('a person on the custodial layer still reads the ledger', () => {
    const analytics = new SpendAnalytics(noSpaces, noLedger, custodialOnly);
    return expect(analytics.spendSummary({ userId: ADA, assetId: 'USDT', range: wholeDay() })).rejects.toThrow('not read');
  });
});

describe('the TEST partner record', () => {
  it('lists a pay-in only when asked, and never answers a move key with it', async () => {
    const partner = held();
    expect(await partner.bank.moves(ADA, { limit: 10 })).toEqual([]);
    const lines = await partner.bank.moves(ADA, { limit: 10, payIns: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amount: amt('200'), to: main(ADA) });
    expect(await partner.bank.moveByKey(lines[0]!.key)).toBeNull();
  });

  it("reports the send limit, what left the person today and its fee; own-space moves don't count, a blank fee is null", async () => {
    const partner = held();
    await partner.bank.move({ key: 'k-send-2', from: main(ADA), to: main(BOB), amount: amt('80') });
    await partner.bank.move({ key: 'k-own-2', from: main(ADA), to: { userId: ADA, assetId: 'USDT', spaceId: 'trip' }, amount: amt('20') });
    expect(await partner.bank.limits(ADA, 'USDT')).toMatchObject({
      dailySend: amt(TEST_PARTNER_DAILY_SEND),
      usedToday: amt('80'),
      sendFee: amt(TEST_PARTNER_SEND_FEE),
    });
    partner.set(ADA, { fee: 'unknown' });
    expect((await partner.bank.limits(ADA, 'USDT')).sendFee).toBeNull();
  });
});
