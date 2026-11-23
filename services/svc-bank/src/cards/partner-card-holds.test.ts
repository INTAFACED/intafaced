/**
 * The TEST partner card's holds (OWNER 226; seam B on project-state #1790): every instruction once under its business
 * key, the partner's own refusals, its hold time, and "not known" never read as 0. No database, no ledger: the partner
 * holds the money, so nothing here can post.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { BankError } from '../errors.js';
import { TEST_PARTNER_UNLISTED_DECLINE, moneyHeldBy, partnerUnset, testPartner } from '../partner/test-partner.js';
import { SWITCHES_OFF, type TestPartnerSwitches } from '../partner/test-partner-switches.js';
import { NOTHING_REPORTED, type CardPartnerTerms } from './partner-terms.js';
import { PartnerCardRefusal, TEST_CARD_HOLD_DAYS, partnerCardKey, testPartnerCardHolds } from './partner-card-holds.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const AUTH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOLD = partnerCardKey('hold', AUTH);

const terms = (over: Partial<CardPartnerTerms> = {}): CardPartnerTerms => ({
  ...NOTHING_REPORTED,
  custodyMode: 'partner_holds',
  balances: { USDC: '100' },
  ...over,
});

function partnerCard(
  over: Partial<CardPartnerTerms> = {},
  switches: Partial<TestPartnerSwitches> = {},
  now = () => new Date('2026-11-09T00:00:00Z'),
) {
  return testPartnerCardHolds({ terms: () => terms(over), switches: () => ({ ...SWITCHES_OFF, ...switches }), clock: now });
}

async function codeOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
  } catch (err) {
    return err instanceof BankError ? err.code : String(err);
  }
  return null;
}

describe('the business keys are the authorisation id, never the network reference', () => {
  it('names each instruction', () => {
    expect(partnerCardKey('hold', AUTH)).toBe(`card.partner.hold:${AUTH}`);
    expect(partnerCardKey('capture', AUTH)).toBe(`card.partner.capture:${AUTH}`);
    expect(partnerCardKey('release', AUTH)).toBe(`card.partner.release:${AUTH}`);
    expect(partnerCardKey('refund', AUTH)).toBe(`card.partner.refund:${AUTH}`);
  });
});

describe('whose book holds the money', () => {
  it('the TEST switch off is the partner; otherwise the custody switch decides; neither is nobody', () => {
    const partner = testPartner();
    expect(moneyHeldBy(partner, ADA, 'on')).toBe('ledger');
    expect(moneyHeldBy(partner, ADA, 'off')).toBe('none');
    partner.set(ADA, { custody: 'off' });
    expect(moneyHeldBy(partner, ADA, 'on')).toBe('partner');
    expect(moneyHeldBy(partner, ADA, 'off')).toBe('partner');
    expect(moneyHeldBy(null, ADA, 'on')).toBe('ledger');
    expect(moneyHeldBy(null, ADA, 'off')).toBe('none');
    expect(partnerUnset().code).toBe('bank.partner_unset');
  });

  it('the switches start on and live', () => {
    expect(SWITCHES_OFF.custody).toBe('on');
    expect(SWITCHES_OFF.cardHold).toBe('live');
    expect(SWITCHES_OFF.cardDecline).toBe('none');
  });
});

describe('the TEST partner card holds from the partner balance, once per key', () => {
  it('holds, reports its figures, and replays the same answer for the same key', async () => {
    const card = partnerCard();
    const first = await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '40' });
    expect(first).toMatchObject({ approved: true, figures: { test: true, available: '60', held: '40', mode: 'partner_holds' } });
    const again = await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '40' });
    expect(again).toEqual(first);
    expect(await card.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '60', held: '40' });
  });

  it('refuses the same key for a different instruction, and moves nothing', async () => {
    const card = partnerCard();
    await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '40' });
    expect(await codeOf(card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '41' }))).toBe('bank.card_partner_key_conflict');
    expect(await card.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '60', held: '40' });
  });

  it('declines when the partner balance is short, holding nothing', async () => {
    const card = partnerCard();
    const answer = await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '100.000000000000000001' });
    expect(answer).toMatchObject({ approved: false, reason: 'bank.card_partner_insufficient_funds' });
    expect(await card.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '100', held: '0' });
  });

  it('an asset with no reported figure is not known, and no hold can be asked in it', async () => {
    const card = partnerCard();
    expect(await card.figures({ userId: ADA, assetId: 'BTC' })).toMatchObject({ available: null, held: null });
    const refused = card.hold({ key: HOLD, userId: ADA, assetId: 'BTC', amount: '1' });
    await expect(refused).rejects.toBeInstanceOf(PartnerCardRefusal);
    expect(await codeOf(card.hold({ key: HOLD, userId: ADA, assetId: 'BTC', amount: '1' }))).toBe('bank.card_partner_balance_not_known');
  });

  it('a partner that has not said its mode refuses to hold', async () => {
    const card = partnerCard({ custodyMode: null });
    expect(await codeOf(card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '1' }))).toBe('bank.card_partner_mode_not_known');
    expect((await card.figures({ userId: ADA, assetId: 'USDC' })).mode).toBeNull();
  });

  it('in wallet_pull mode the answer says the card pulls from the wallet', async () => {
    const card = partnerCard({ custodyMode: 'wallet_pull' });
    const answer = await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '5' });
    expect(answer).toMatchObject({ approved: true, hold: { mode: 'wallet_pull', test: true } });
  });
});

describe('capture, release, expiry and refund are the partner’s, each once', () => {
  async function held(over: Partial<TestPartnerSwitches> = {}, now?: () => Date) {
    const card = partnerCard({}, over, now);
    await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '40' });
    return card;
  }

  it('refuses a capture above the hold, then captures within it and releases the rest', async () => {
    const card = await held();
    expect(await codeOf(card.capture({ key: partnerCardKey('capture', AUTH), holdKey: HOLD, amount: '40.01' }))).toBe(
      'bank.card_partner_capture_exceeds_hold',
    );
    const captured = await card.capture({ key: partnerCardKey('capture', AUTH), holdKey: HOLD, amount: '30' });
    expect(captured).toMatchObject({ amount: '30', by: 'instruction', hold: { status: 'captured', open: '10' } });
    const released = await card.release({ key: partnerCardKey('release', AUTH), holdKey: HOLD });
    expect(released).toMatchObject({ amount: '10', hold: { open: '0', captured: '30', released: '10' } });
    expect(released.figures).toMatchObject({ available: '70', held: '0' });
    expect(await codeOf(card.capture({ key: `${partnerCardKey('capture', AUTH)}:again`, holdKey: HOLD, amount: '1' }))).toBe(
      'bank.card_partner_hold_closed',
    );
  });

  it('gives an uncaptured hold back when its hold time runs out, and says so', async () => {
    let now = new Date('2026-11-09T00:00:00Z');
    const card = await held({}, () => now);
    expect((await card.holdState({ holdKey: HOLD }))?.status).toBe('held');
    now = new Date(now.getTime() + TEST_CARD_HOLD_DAYS * 86_400_000 + 1);
    expect(await card.holdState({ holdKey: HOLD })).toMatchObject({ status: 'expired', open: '0', released: '40' });
    expect(await card.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '100', held: '0' });
    const release = await card.release({ key: partnerCardKey('release', AUTH), holdKey: HOLD });
    expect(release).toMatchObject({ by: 'expiry', amount: '40' });
    expect(await codeOf(card.capture({ key: partnerCardKey('capture', AUTH), holdKey: HOLD, amount: '1' }))).toBe(
      'bank.card_partner_hold_closed',
    );
  });

  it('the person’s cardDecline switch declines with a code of the partner’s own, holding nothing, and replays it', async () => {
    const card = partnerCard({}, { cardDecline: 'unlisted' });
    const answer = await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '1' });
    expect(answer).toMatchObject({ approved: false, reason: TEST_PARTNER_UNLISTED_DECLINE, figures: { available: '100', held: '0' } });
    expect(TEST_PARTNER_UNLISTED_DECLINE.startsWith('bank.')).toBe(false);
    expect(await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '1' })).toEqual(answer);
    expect(await card.holdState({ holdKey: HOLD })).toBeNull();
  });

  it('the person’s cardHold switch runs an open hold out at once', async () => {
    const card = await held({ cardHold: 'expired' });
    expect((await card.holdState({ holdKey: HOLD }))?.status).toBe('expired');
  });

  it('refunds up to what was captured, once per key', async () => {
    const card = await held();
    await card.capture({ key: partnerCardKey('capture', AUTH), holdKey: HOLD, amount: '40' });
    expect(await codeOf(card.refund({ key: partnerCardKey('refund', AUTH), holdKey: HOLD, amount: '41' }))).toBe(
      'bank.card_partner_refund_exceeds_capture',
    );
    const refund = await card.refund({ key: partnerCardKey('refund', AUTH), holdKey: HOLD, amount: '15' });
    expect(refund).toMatchObject({ amount: '15', hold: { refunded: '15' }, figures: { available: '75' } });
    expect(await card.refund({ key: partnerCardKey('refund', AUTH), holdKey: HOLD, amount: '15' })).toEqual(refund);
    expect(await card.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '75' });
  });

  it('a hold it has no record of is not found, never a guess', async () => {
    const card = partnerCard();
    expect(await card.holdState({ holdKey: HOLD })).toBeNull();
    expect(await codeOf(card.release({ key: partnerCardKey('release', AUTH), holdKey: HOLD }))).toBe('bank.card_partner_hold_not_found');
  });
});

describe('the TEST card draws on the person’s own partner account (#10227)', () => {
  const at = new Date('2026-11-09T00:00:00Z');
  const units = parseAmount;
  function drawnCard(switches: Partial<TestPartnerSwitches> = {}, now = () => at) {
    const partner = testPartner();
    const card = testPartnerCardHolds({
      terms: () => terms({ rates: { in: 'USDC', perUnit: {} }, spendFrom: ['USDC'] }),
      switches: () => ({ ...SWITCHES_OFF, ...switches }),
      funds: partner.cardFunds,
      clock: now,
    });
    const main = { userId: ADA, assetId: 'USDC', spaceId: null };
    const balance = async () => {
      const b = await partner.bank.balance(main);
      return b.amount;
    };
    return { partner, card, main, balance };
  }

  it('a card payment lowers the partner balance the person reads, once per key, and the statement counts it', async () => {
    const { partner, card, main, balance } = drawnCard();
    partner.fund(ADA, { fundId: 'f-400', assetId: 'USDC', amount: units('400') });
    expect(await card.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '400', held: '0' });

    const held = await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '20' });
    expect(held).toMatchObject({ approved: true, figures: { available: '380', held: '20' } });
    expect(await balance()).toBe(units('380'));
    // The same key again moves nothing more at the partner.
    expect(await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '20' })).toEqual(held);
    expect(await balance()).toBe(units('380'));

    const captured = await card.capture({ key: partnerCardKey('capture', AUTH), holdKey: HOLD, amount: '20' });
    expect(captured.figures).toMatchObject({ available: '380', held: '0' });
    expect(await balance()).toBe(units('380'));

    await card.refund({ key: partnerCardKey('refund', AUTH), holdKey: HOLD, amount: '5' });
    await card.refund({ key: partnerCardKey('refund', AUTH), holdKey: HOLD, amount: '5' });
    expect(await balance()).toBe(units('385'));
    expect(await card.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '385', held: '0' });

    // The card's own list is where a payment is read: no card move is a bank move, and none counts as a send.
    expect(await partner.bank.moves(ADA, { limit: 50 })).toEqual([]);
    expect((await partner.bank.limits(ADA, 'USDC')).usedToday).toBe(0n);
    // The partner's statement of the account still adds up: 400 paid in, 20 held, 5 refunded.
    const statementOf = partner.bank.statement;
    if (!statementOf) throw new Error('the TEST partner offers statements');
    const statement = await statementOf(main, { from: new Date(0), to: new Date(Date.now() + 60_000) });
    expect(statement).toMatchObject({ opening: 0n, closing: units('385') });
    expect(partner.record(ADA).accounts).toEqual([{ account: main, amount: units('385') }]);
  });

  it('a released hold and a hold whose time ran out each come back to the account, once', async () => {
    const { partner, card, balance } = drawnCard();
    partner.fund(ADA, { fundId: 'f-50', assetId: 'USDC', amount: units('50') });
    await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '30' });
    expect(await balance()).toBe(units('20'));
    await card.release({ key: partnerCardKey('release', AUTH), holdKey: HOLD });
    await card.release({ key: partnerCardKey('release', AUTH), holdKey: HOLD });
    expect(await balance()).toBe(units('50'));

    const expiring = drawnCard({ cardHold: 'expired' });
    expiring.partner.fund(ADA, { fundId: 'f-50', assetId: 'USDC', amount: units('50') });
    const second = partnerCardKey('hold', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await expiring.card.hold({ key: second, userId: ADA, assetId: 'USDC', amount: '30' });
    expect(await expiring.card.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '50', held: '0' });
    expect(await expiring.card.holdState({ holdKey: second })).toMatchObject({ status: 'expired' });
    expect(await expiring.balance()).toBe(units('50'));
  });

  it('above what the account holds, the partner declines and nothing moves; an empty account declines too', async () => {
    const { partner, card, balance } = drawnCard();
    const openCurrency = partner.bank.openCurrency;
    if (!openCurrency) throw new Error('the TEST partner opens currency accounts');
    await openCurrency(ADA, 'USDC');
    expect(await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '5' })).toMatchObject({
      approved: false,
      reason: 'bank.card_partner_insufficient_funds',
      figures: { available: '0' },
    });
    partner.fund(ADA, { fundId: 'f-10', assetId: 'USDC', amount: units('10') });
    const other = partnerCardKey('hold', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(await card.hold({ key: other, userId: ADA, assetId: 'USDC', amount: '10.01' })).toMatchObject({ approved: false });
    expect(await balance()).toBe(units('10'));
    expect(partner.record(ADA).moves.filter((m) => m.key.startsWith('card.partner'))).toEqual([]);
  });

  it('a hold by the person’s pay-from order draws on the account too', async () => {
    const { partner, card, balance } = drawnCard();
    partner.fund(ADA, { fundId: 'f-100', assetId: 'USDC', amount: units('100') });
    if (!card.holdInOrder) throw new Error('the TEST partner card takes pay-from orders');
    const answer = await card.holdInOrder({ key: HOLD, userId: ADA, order: ['USDC'], settlementAssetId: 'USDC', amount: '12.5' });
    expect(answer).toMatchObject({ approved: true, figures: { available: '87.5', held: '12.5' } });
    expect(await balance()).toBe(units('87.5'));
  });

  it('with no account at the partner the card holds from the TEST figure; an open hold goes back where it came from', async () => {
    const { partner, card, balance } = drawnCard();
    expect(await card.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '100' });
    await card.hold({ key: HOLD, userId: ADA, assetId: 'USDC', amount: '10' });
    // The account opens while the TEST figure's hold is open: the book keeps to the figure until it holds nothing.
    partner.fund(ADA, { fundId: 'f-40', assetId: 'USDC', amount: units('40') });
    expect(await card.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '90', held: '10' });
    await card.release({ key: partnerCardKey('release', AUTH), holdKey: HOLD });
    expect(await balance()).toBe(units('40'));
    expect(await card.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '40', held: '0' });
  });
});
