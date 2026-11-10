/**
 * The partner-held bank port (OWNER 226) and the TEST partner bank's book: balances as the partner reports them, one
 * move per business key, a retry after a lost reply makes one move, and refusals that move nothing. Also the custody
 * switch as svc-bank reads it: off, a customer-balance post is refused by name before svc-ledger is asked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import {
  bankCustodyLayer,
  custodyGuardedLedger,
  ledgerPostingFreeze,
  freezeGuardedCustody,
  partnerAccountFor,
  partnerFigure,
  reportedAmount,
  type PartnerAccountRef,
} from './partner-bank.js';
import { TEST_PARTNER_LABEL, TEST_PARTNER_STALE_AFTER_MS, testPartner, testPartnerCustody } from './test-partner.js';

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
    expect(report.asOf!.getTime()).toBeGreaterThanOrEqual(before);
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

  it("one person's fund id never collides with another's", async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-0001', assetId: 'USDT', amount: amt('100') });
    partner.fund(BOB, { fundId: 'fund-0001', assetId: 'USDT', amount: amt('7') });
    expect((await partner.bank.balance(main(BOB))).amount).toBe(amt('7'));
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
    // Down, with no figure given before, the balance is not known (b2 change 6); answering again, it still holds 10.
    expect((await partner.bank.balance(main(ADA))).amount).toBeNull();
    partner.set(ADA, { down: false });
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

  it('a balance the partner sent with no time is refused by name too: we cannot say how old it is', () => {
    expect(() => reportedAmount({ account: main(ADA), amount: amt('5'), asOf: null, label: TEST_PARTNER_LABEL })).toThrow(
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

describe("the partner's displayed figure (b2 change 6)", () => {
  it('the TEST partner declares its staleness limit, labelled TEST, and the freeze wrapper keeps it', () => {
    const partner = testPartner();
    expect(partner.bank.staleAfterMs).toBe(TEST_PARTNER_STALE_AFTER_MS);
    partner.set(ADA, { custody: 'off' });
    const wrapped = freezeGuardedCustody(testPartnerCustody(partner), { postingEnabled: async () => true }).bankFor(ADA)!;
    expect(wrapped.staleAfterMs).toBe(TEST_PARTNER_STALE_AFTER_MS);
  });

  it("live: known, with the partner's own time and its figure as a decimal string", async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('12.5') });
    const report = await partner.bank.balance(main(ADA));
    const figure = partnerFigure(report, partner.bank.staleAfterMs, new Date());
    expect(figure).toMatchObject({ state: 'known', source: TEST_PARTNER_LABEL, amount: '12.5', asOf: report.asOf });
  });

  it("stale: the partner's figure, with a time older than its limit, reads stale and still shows the amount", async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('7') });
    partner.set(ADA, { figures: 'stale' });
    const report = await partner.bank.balance(main(ADA));
    expect(Date.now() - report.asOf!.getTime()).toBeGreaterThan(TEST_PARTNER_STALE_AFTER_MS);
    expect(partnerFigure(report, partner.bank.staleAfterMs, new Date())).toMatchObject({ state: 'stale', amount: '7' });
    // A stale figure is still the partner's: a move may use it, and the display says how old it is.
    expect(reportedAmount(report)).toBe(amt('7'));
  });

  it('unknown: every balance reads not known with no time, never 0, and every read of it refuses by name', async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('7') });
    partner.set(ADA, { figures: 'unknown' });
    const report = await partner.bank.balance(main(ADA));
    expect(report).toMatchObject({ amount: null, asOf: null, label: TEST_PARTNER_LABEL });
    expect(partnerFigure(report, partner.bank.staleAfterMs, new Date())).toMatchObject({ state: 'unknown', reason: 'not_reported' });
    expect(await codeOf(() => reportedAmount(report))).toBe('bank.partner_balance_not_known');
    for (const b of await partner.bank.balances(ADA)) expect(b.amount).toBeNull();
    // Funding is the partner's answer to a write it made, so it still reports what it now holds.
    expect(partner.fund(ADA, { fundId: 'fund-ada-2', assetId: 'USDT', amount: amt('1') }).amount).toBe(amt('8'));
    partner.set(ADA, { figures: 'live' });
    expect((await partner.bank.balance(main(ADA))).amount).toBe(amt('8'));
  });

  it("down: a read gives the last figure the partner gave, with the partner's time for it, never a fresh time", async () => {
    const partner = testPartner();
    partner.fund(ADA, { fundId: 'fund-ada-1', assetId: 'USDT', amount: amt('9') });
    const given = await partner.bank.balance(main(ADA));
    await new Promise((r) => setTimeout(r, 5));
    partner.set(ADA, { down: true });
    const read = await partner.bank.balance(main(ADA));
    expect(read).toMatchObject({ amount: amt('9'), asOf: given.asOf, unavailable: true });
    expect(partnerFigure(read, partner.bank.staleAfterMs, new Date(given.asOf!.getTime() + TEST_PARTNER_STALE_AFTER_MS + 1))).toMatchObject(
      {
        state: 'stale',
        amount: '9',
      },
    );
  });

  it('down with nothing given before: not known (source_unavailable), never 0', async () => {
    const partner = testPartner();
    partner.fund(BOB, { fundId: 'fund-bob-1', assetId: 'USDT', amount: amt('3') });
    partner.set(BOB, { down: true });
    const read = await partner.bank.balance(space(BOB, 'trip'));
    expect(read).toMatchObject({ amount: null, asOf: null, unavailable: true });
    expect(partnerFigure(read, partner.bank.staleAfterMs, new Date())).toMatchObject({ state: 'unknown', reason: 'source_unavailable' });
    expect(await codeOf(() => reportedAmount(read))).toBe('bank.partner_balance_not_known');
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

describe("ledgerPostingFreeze: svc-ledger's /health as svc-bank reads it", () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('reads posting enabled only from an exact postingEnabled: true', async () => {
    expect(await ledgerPostingFreeze('http://ledger.test', answer(200, { ok: true, postingEnabled: true })).postingEnabled()).toBe(true);
    expect(await ledgerPostingFreeze('http://ledger.test', answer(200, { ok: true, postingEnabled: false })).postingEnabled()).toBe(false);
    expect(await ledgerPostingFreeze('http://ledger.test', answer(200, { ok: true })).postingEnabled()).toBe(false);
    expect(await ledgerPostingFreeze('http://ledger.test', answer(200, { postingEnabled: 'true' })).postingEnabled()).toBe(false);
  });
  it('throws when svc-ledger answers an error, so the guard refuses', async () => {
    await expect(ledgerPostingFreeze('http://ledger.test', answer(503, {})).postingEnabled()).rejects.toThrow('503');
  });
});
