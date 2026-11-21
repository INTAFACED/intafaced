import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { partnerPayoutsAccount } from './partner-bank.js';
import { testPartner } from './test-partner.js';
import { answerTestPartnerRecord, onLoopback, TEST_PARTNER_RECORD_ID } from './test-partner-record.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const account = (owner: string) => ({ account: { venueId: TEST_PARTNER_RECORD_ID, owner, subAccount: null } });

describe('the TEST partner bank record read', () => {
  it('names itself, TEST', () => {
    expect(answerTestPartnerRecord(testPartner(), 'GET', '/venue', null)).toEqual([
      200,
      { label: 'TEST', venue: { id: TEST_PARTNER_RECORD_ID, displayName: 'TEST partner bank' } },
    ]);
  });

  it("answers one person's book as the partner keeps it: balances and every move once, never another person's", async () => {
    const p = testPartner();
    p.fund(ADA, { fundId: 'f1', assetId: 'USDT', amount: parseAmount('50') });
    p.fund(BOB, { fundId: 'f1', assetId: 'USDT', amount: parseAmount('7') });
    const req = {
      key: 'k1',
      from: { userId: ADA, assetId: 'USDT', spaceId: null },
      to: partnerPayoutsAccount('USDT'),
      amount: parseAmount('20'),
    };
    const move = await p.bank.move(req);
    expect(await p.bank.move(req)).toBe(move);

    const [status, body] = answerTestPartnerRecord(p, 'POST', '/balances', account(ADA));
    expect(status).toBe(200);
    expect(body).toEqual({ label: 'TEST', value: [{ asset: 'USDT', free: '30', locked: '0', total: '30' }] });
    const [, moves] = answerTestPartnerRecord(p, 'POST', '/moves', account(ADA)) as [
      number,
      { value: { id: string; key: string; amount: string }[] },
    ];
    expect(moves.value.map((m) => [m.key, m.amount])).toEqual([
      [`pay-in:${ADA}|f1`, '50'],
      ['k1', '20'],
    ]);
    expect(moves.value[1]!.id).toBe(move.id);
  });

  it('shows what the partner holds even while it tells the app its figure is not known', () => {
    const p = testPartner();
    p.fund(ADA, { fundId: 'f1', assetId: 'USDT', amount: parseAmount('5') });
    p.set(ADA, { figures: 'unknown', down: true });
    expect(answerTestPartnerRecord(p, 'POST', '/balances', account(ADA))[1]).toMatchObject({ value: [{ asset: 'USDT', total: '5' }] });
  });

  it('refuses another venue id, a missing owner, a sub-account, a wrong method and an unknown path', () => {
    const p = testPartner();
    expect(answerTestPartnerRecord(p, 'POST', '/balances', { account: { venueId: 'other', owner: ADA } })[0]).toBe(400);
    expect(answerTestPartnerRecord(p, 'POST', '/balances', { account: { venueId: TEST_PARTNER_RECORD_ID } })[0]).toBe(400);
    expect(
      answerTestPartnerRecord(p, 'POST', '/moves', { account: { venueId: TEST_PARTNER_RECORD_ID, owner: ADA, subAccount: 'x' } })[0],
    ).toBe(400);
    expect(answerTestPartnerRecord(p, 'GET', '/balances', null)[0]).toBe(405);
    expect(answerTestPartnerRecord(p, 'POST', '/venue', null)[0]).toBe(405);
    expect(answerTestPartnerRecord(p, 'POST', '/fund', account(ADA))[0]).toBe(404);
  });

  it('answers loopback callers only', () => {
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1'].every(onLoopback)).toBe(true);
    expect(['10.0.0.2', '192.168.1.4', undefined].some(onLoopback)).toBe(false);
  });
});
