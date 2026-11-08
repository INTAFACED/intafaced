/**
 * The TEST partner card's holds (OWNER 226; seam B on project-state #1790): every instruction once under its business
 * key, the partner's own refusals, its hold time, and "not known" never read as 0. No database, no ledger: the partner
 * holds the money, so nothing here can post.
 */
import { describe, expect, it } from 'vitest';
import { BankError } from '../errors.js';
import { SWITCHES_OFF, moneyHeldBy, partnerUnset, testPartner, type TestPartnerSwitches } from '../partner/test-partner.js';
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
