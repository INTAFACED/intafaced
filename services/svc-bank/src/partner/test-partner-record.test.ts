import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { partnerPayoutsAccount } from './partner-bank.js';
import { testPartner } from './test-partner.js';
import { answerTestPartnerRecord, onLoopback, TEST_PARTNER_RECORD_ID } from './test-partner-record.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const account = (owner: string) => ({ account: { venueId: TEST_PARTNER_RECORD_ID, owner, subAccount: null } });

describe('the TEST partner bank record read', () => {
  it('names itself, TEST', async () => {
    expect(await answerTestPartnerRecord(testPartner(), 'GET', '/venue', null)).toEqual([
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

    const [status, body] = await answerTestPartnerRecord(p, 'POST', '/balances', account(ADA));
    expect(status).toBe(200);
    expect(body).toEqual({ label: 'TEST', value: [{ asset: 'USDT', free: '30', locked: '0', total: '30' }] });
    const [, moves] = (await answerTestPartnerRecord(p, 'POST', '/moves', account(ADA))) as [
      number,
      { value: { id: string; key: string; amount: string }[] },
    ];
    expect(moves.value.map((m) => [m.key, m.amount])).toEqual([
      [`pay-in:${ADA}|f1`, '50'],
      ['k1', '20'],
    ]);
    expect(moves.value[1]!.id).toBe(move.id);
  });

  it('answers every account it holds for one person, main balances and spaces, a currency it opened once, and its open orders', async () => {
    const p = testPartner();
    p.fund(ADA, { fundId: 'f1', assetId: 'USDT', amount: parseAmount('50') });
    await p.bank.openCurrency!(ADA, 'USDC');
    await p.bank.openCurrency!(ADA, 'USDC');
    await p.bank.move({
      key: 'k-space',
      from: { userId: ADA, assetId: 'USDT', spaceId: null },
      to: { userId: ADA, assetId: 'USDT', spaceId: 'space-1' },
      amount: parseAmount('20'),
    });
    p.fund(BOB, { fundId: 'f1', assetId: 'USDT', amount: parseAmount('7') });
    const [status, body] = await answerTestPartnerRecord(p, 'POST', '/accounts', account(ADA));
    expect(status).toBe(200);
    expect((body as { value: unknown[] }).value).toEqual(
      expect.arrayContaining([
        { asset: 'USDT', spaceId: null, amount: '30' },
        { asset: 'USDC', spaceId: null, amount: '0' },
        { asset: 'USDT', spaceId: 'space-1', amount: '20' },
      ]),
    );
    expect((body as { value: unknown[] }).value).toHaveLength(3);
    expect(await answerTestPartnerRecord(p, 'POST', '/open-orders', account(ADA))).toEqual([200, { label: 'TEST', value: [] }]);
    p.set(ADA, { openOrder: 'USDC' });
    expect(await answerTestPartnerRecord(p, 'POST', '/open-orders', account(ADA))).toEqual([
      200,
      { label: 'TEST', value: [{ id: `TEST-order:${ADA}:USDC`, asset: 'USDC' }] },
    ]);
    expect((await answerTestPartnerRecord(p, 'POST', '/open-orders', account(BOB)))[1]).toEqual({ label: 'TEST', value: [] });
  });

  it('opens no currency account while it is down', async () => {
    const p = testPartner();
    p.set(ADA, { down: true });
    await expect(p.bank.openCurrency!(ADA, 'USDC')).rejects.toMatchObject({ code: 'bank.partner_unavailable' });
    p.set(ADA, { down: false });
    expect((await answerTestPartnerRecord(p, 'POST', '/accounts', account(ADA)))[1]).toEqual({ label: 'TEST', value: [] });
  });

  it('shows what the partner holds even while it tells the app its figure is not known', async () => {
    const p = testPartner();
    p.fund(ADA, { fundId: 'f1', assetId: 'USDT', amount: parseAmount('5') });
    p.set(ADA, { figures: 'unknown', down: true });
    expect((await answerTestPartnerRecord(p, 'POST', '/balances', account(ADA)))[1]).toMatchObject({
      value: [{ asset: 'USDT', total: '5' }],
    });
  });

  it('refuses another venue id, a missing owner, a sub-account, a wrong method and an unknown path', async () => {
    const p = testPartner();
    expect((await answerTestPartnerRecord(p, 'POST', '/balances', { account: { venueId: 'other', owner: ADA } }))[0]).toBe(400);
    expect((await answerTestPartnerRecord(p, 'POST', '/balances', { account: { venueId: TEST_PARTNER_RECORD_ID } }))[0]).toBe(400);
    expect(
      (
        await answerTestPartnerRecord(p, 'POST', '/moves', { account: { venueId: TEST_PARTNER_RECORD_ID, owner: ADA, subAccount: 'x' } })
      )[0],
    ).toBe(400);
    expect((await answerTestPartnerRecord(p, 'GET', '/balances', null))[0]).toBe(405);
    expect((await answerTestPartnerRecord(p, 'POST', '/venue', null))[0]).toBe(405);
    expect((await answerTestPartnerRecord(p, 'POST', '/fund', account(ADA)))[0]).toBe(404);
  });

  it("answers one person's onboarding as the partner keeps it: its requirements, whether it accepts our case, its requests", async () => {
    const p = testPartner();
    const opened = p.compliance.openRequest(ADA, 'r1', 14);
    p.compliance.openRequest(BOB, 'r2', 7);
    p.set(BOB, { identityCase: 'not_accepted' });
    expect(await answerTestPartnerRecord(p, 'POST', '/onboarding', account(ADA))).toEqual([
      200,
      {
        label: 'TEST',
        value: {
          requirements: ['TEST: be 18 or older', 'TEST: live in a country the partner bank serves'],
          identityCaseAccepted: true,
          requests: [{ id: 'r1', title: opened.title, status: 'open', dueAt: opened.dueAt.toISOString() }],
        },
      },
    ]);
    expect(await answerTestPartnerRecord(p, 'POST', '/onboarding', account(BOB))).toMatchObject([
      200,
      { value: { identityCaseAccepted: false, requests: [{ id: 'r2', status: 'open' }] } },
    ]);
    expect((await answerTestPartnerRecord(p, 'GET', '/onboarding', null))[0]).toBe(405);
  });

  it('answers the account details it issued one person, with the holder name it keeps, and none before it issues them', async () => {
    const p = testPartner();
    const ask = (owner: string, currency?: unknown) =>
      answerTestPartnerRecord(p, 'POST', '/account-details', { ...account(owner), currency });
    expect(await ask(ADA, 'USD')).toEqual([200, { label: 'TEST', value: { issued: false, holderName: null, sets: [] } }]);
    p.set(ADA, { accountDetails: 'issued', holderName: 'TEST Ada' });
    const [status, body] = (await ask(ADA, 'USD')) as [number, { value: { issued: boolean; holderName: string; sets: unknown[] } }];
    expect(status).toBe(200);
    expect(body.value).toMatchObject({ issued: true, holderName: 'TEST Ada' });
    expect(body.value.sets).toEqual([
      expect.objectContaining({
        id: `test-partner:${ADA}:USD`,
        accountNumber: `TEST-USD-${ADA.replace(/-/g, '').toUpperCase()}`,
        partnerBank: 'TEST partner bank',
      }),
    ]);
    // The partner down still keeps its record: the read is its own book, not its answer to the app.
    p.set(ADA, { down: true });
    expect((await ask(ADA, 'USD'))[1]).toMatchObject({ value: { issued: true, sets: [{ id: `test-partner:${ADA}:USD` }] } });
    expect((await ask(BOB, 'USD'))[1]).toMatchObject({ value: { issued: false, sets: [] } });
    expect((await ask(ADA))[0]).toBe(400);
    expect((await ask(ADA, 'usd'))[0]).toBe(400);
    expect((await answerTestPartnerRecord(p, 'GET', '/account-details', null))[0]).toBe(405);
  });

  it('answers loopback callers only', () => {
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1'].every(onLoopback)).toBe(true);
    expect(['10.0.0.2', '192.168.1.4', undefined].some(onLoopback)).toBe(false);
  });
});
