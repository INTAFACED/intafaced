/**
 * The partner-held bank port (OWNER 226) and the TEST partner bank's book: balances as the partner reports them, one
 * move per business key, a retry after a lost reply makes one move, and refusals that move nothing. Also the custody
 * switch as svc-bank reads it: off, a customer-balance post is refused by name before svc-ledger is asked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { bankCustodyLayer, custodyGuardedLedger, partnerAccountFor, reportedAmount, type PartnerAccountRef } from './partner-bank.js';
import { TEST_PARTNER_LABEL, testPartner, testPartnerCustody } from './test-partner.js';

const ADA = 'ada-0001';
const BOB = 'bob-0002';
const main = (userId: string): PartnerAccountRef => ({ userId, assetId: 'USDT', spaceId: null });
const space = (userId: string, spaceId: string): PartnerAccountRef => ({ userId, assetId: 'USDT', spaceId });
const amt = parseAmount;
const codeOf = (fn: () => unknown) =>
  Promise.resolve()
    .then(fn)
    .then(
      () => 'resolved',
      (err: unknown) => (err as { code?: string }).code,
    );

describe('the TEST partner bank book', () => {
  it('reports each balance labelled TEST with the time it reported it; an account nobody paid into holds 0', async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('100') });
    const before = Date.now();
    const report = await partner.bank.balance(main(ADA));
    expect(report).toMatchObject({ account: main(ADA), amount: amt('100'), label: TEST_PARTNER_LABEL });
    expect(report.label).toMatch(/TEST/);
    expect(report.asOf.getTime()).toBeGreaterThanOrEqual(before);
    expect((await partner.bank.balance(space(ADA, 'trip'))).amount).toBe(0n);
  });

  it('funds once per fund id, and refuses the same id with another amount', async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('100') });
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('100') });
    expect((await partner.bank.balance(main(ADA))).amount).toBe(amt('100'));
    expect(await codeOf(() => partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('5') }))).toBe(
      'bank.partner_move_conflict',
    );
  });

  it('makes one move under one key: both balances change by exactly the amount, and a resend is the same move', async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('100') });
    const request = { key: 'bank.transfer.own:t-1:0', from: main(ADA), to: space(ADA, 'trip'), amount: amt('20') };
    const first = await partner.bank.move(request);
    const again = await partner.bank.move(request);
    expect(again).toBe(first);
    expect(first.label).toBe(TEST_PARTNER_LABEL);
    expect(formatAmount((await partner.bank.balance(main(ADA))).amount!)).toBe('80');
    expect(formatAmount((await partner.bank.balance(space(ADA, 'trip'))).amount!)).toBe('20');
    expect(await partner.bank.moves(ADA, { limit: 10 })).toEqual([first]);
    expect(await partner.bank.moveByKey(request.key)).toBe(first);
  });

  it('a retry after a lost reply makes one move, never two', async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('100') });
    partner.set(ADA, { nextReply: 'lost' });
    const request = { key: 'bank.transfer.own:t-lost:0', from: main(ADA), to: space(ADA, 'trip'), amount: amt('20') };
    expect(await codeOf(() => partner.bank.move(request))).toBe('bank.partner_reply_lost');
    // The reply is lost once; the switch goes back by itself.
    expect(partner.switches(ADA).nextReply).toBe('answered');
    const retry = await partner.bank.move(request);
    expect(retry.key).toBe(request.key);
    expect(await partner.bank.moves(ADA, { limit: 10 })).toHaveLength(1);
    expect((await partner.bank.balance(main(ADA))).amount).toBe(amt('80'));
    expect((await partner.bank.balance(space(ADA, 'trip'))).amount).toBe(amt('20'));
  });

  it('refuses a different move under a used key, moving nothing', async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('100') });
    const key = 'bank.transfer.own:t-2:0';
    await partner.bank.move({ key, from: main(ADA), to: space(ADA, 'trip'), amount: amt('20') });
    expect(await codeOf(() => partner.bank.move({ key, from: main(ADA), to: space(ADA, 'trip'), amount: amt('21') }))).toBe(
      'bank.partner_move_conflict',
    );
    expect(await codeOf(() => partner.bank.move({ key, from: main(ADA), to: space(ADA, 'rent'), amount: amt('20') }))).toBe(
      'bank.partner_move_conflict',
    );
    expect((await partner.bank.balance(main(ADA))).amount).toBe(amt('80'));
  });

  it('refuses a move the source cannot cover, a move while down, and a zero amount, each moving nothing', async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('10') });
    const to = space(ADA, 'trip');
    expect(await codeOf(() => partner.bank.move({ key: 'k-over-0001', from: main(ADA), to, amount: amt('10.000000000000000001') }))).toBe(
      'bank.partner_insufficient_funds',
    );
    expect(await codeOf(() => partner.bank.move({ key: 'k-zero-0001', from: main(ADA), to, amount: 0n }))).toBe(
      'bank.partner_amount_invalid',
    );
    partner.set(ADA, { down: true });
    expect(await codeOf(() => partner.bank.move({ key: 'k-down-0001', from: main(ADA), to, amount: amt('1') }))).toBe(
      'bank.partner_unavailable',
    );
    expect((await partner.bank.balance(main(ADA))).amount).toBe(amt('10'));
    expect(await partner.bank.moves(ADA, { limit: 10 })).toEqual([]);
    expect(await partner.bank.moveByKey('k-over-0001')).toBeNull();
  });

  it("answers a resend of a move it already made even while it is down, so a lost reply's retry is never refused", async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('10') });
    const request = { key: 'k-made-0001', from: main(ADA), to: space(ADA, 'trip'), amount: amt('1') };
    const made = await partner.bank.move(request);
    partner.set(ADA, { down: true });
    expect(await partner.bank.move(request)).toBe(made);
  });

  it("lists each person's moves newest first, both sides of a move between two people, and pages by reference", async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('10') });
    const one = await partner.bank.move({ key: 'k-one-0001', from: main(ADA), to: space(ADA, 'trip'), amount: amt('1') });
    const two = await partner.bank.move({ key: 'k-two-0001', from: main(ADA), to: main(BOB), amount: amt('2') });
    expect(await partner.bank.moves(ADA, { limit: 10 })).toEqual([two, one]);
    expect(await partner.bank.moves(BOB, { limit: 10 })).toEqual([two]);
    expect(await partner.bank.moves(ADA, { limit: 10, before: two.id })).toEqual([one]);
    expect(await partner.bank.balances(BOB)).toEqual([expect.objectContaining({ account: main(BOB), amount: amt('2') })]);
  });

  it('a space maps to the partner account: a primary space is the main balance', () => {
    expect(partnerAccountFor({ id: 's-1', userId: ADA, assetId: 'USDT', kind: 'primary' })).toEqual(main(ADA));
    expect(partnerAccountFor({ id: 's-2', userId: ADA, assetId: 'USDT', kind: 'named' })).toEqual(space(ADA, 's-2'));
  });

  it('a balance the partner has not reported is refused by name, never read as 0', () => {
    expect(() => reportedAmount({ account: main(ADA), amount: null, asOf: new Date(), label: TEST_PARTNER_LABEL })).toThrow(
      expect.objectContaining({ code: 'bank.partner_balance_not_known' }),
    );
  });

  it('the custody switch is per person: only a person with custody off is held at the partner', () => {
    const partner = testPartner();
    const custody = testPartnerCustody(partner);
    expect(partner.switches(ADA).custody).toBe('on');
    expect(custody.bankFor(ADA)).toBeNull();
    partner.set(ADA, { custody: 'off' });
    expect(custody.bankFor(ADA)).toBe(partner.bank);
    expect(custody.bankFor(BOB)).toBeNull();
    expect(testPartnerCustody(null).bankFor(ADA)).toBeNull();
  });
});

describe('the custody switch as svc-bank reads it', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is off when unset or blank, follows on and off, and refuses any other value', () => {
    vi.stubEnv('LEDGER_CUSTODY_LAYER', '');
    expect(bankCustodyLayer(undefined)).toBe('off');
    vi.stubEnv('LEDGER_CUSTODY_LAYER', 'on');
    expect(bankCustodyLayer(undefined)).toBe('on');
    expect(bankCustodyLayer('off')).toBe('off');
    vi.stubEnv('LEDGER_CUSTODY_LAYER', 'true');
    expect(() => bankCustodyLayer(undefined)).toThrow(/LEDGER_CUSTODY_LAYER/);
  });

  it('off: a customer-balance post refuses bank.no_partner_bank and never reaches the ledger', async () => {
    const book = new MemoryLedger();
    const post = vi.spyOn(book, 'post');
    const guarded = custodyGuardedLedger(book, 'off');
    const deposit = recipes.deposit({ userId: ADA, assetId: 'USDT', amount: amt('5'), rail: 'test', railRef: 'r-1' });
    await expect(guarded.post(deposit)).rejects.toMatchObject({ code: 'bank.no_partner_bank' });
    expect(post).not.toHaveBeenCalled();
    expect(book.journal()).toEqual([]);
    // Reads still pass through.
    expect((await guarded.balance(userAvailable(ADA, 'USDT'))).amount).toBe(0n);
  });

  it('on: the ledger is the same object, every post passes through unchanged', async () => {
    const book = new MemoryLedger();
    expect(custodyGuardedLedger(book, 'on')).toBe(book);
  });
});
