/**
 * The TEST partner card adapter's switches (CUSTODY-DELTA §4, row "TEST partner card"; §1.3 "Unknown, never zero").
 *
 * Each switch's "not known" or "not offered by the partner" path is asserted at the adapter, and the switches are planted
 * in a production config to see them refused (the way `rails/posture.ts` refuses sandbox rails).
 */
import { describe, expect, it } from 'vitest';
import { cardIssuerFor, cardSim, noCardIssuer } from './issuer.js';
import {
  NOTHING_REPORTED,
  NOT_KNOWN,
  NOT_OFFERED_BY_PARTNER,
  cardSimPartnerFor,
  custodyModeWords,
  parseSpendAssets,
  partnerTermsView,
  payFromAssets,
  requireSpendAssets,
  type CardPartnerTerms,
} from './partner-terms.js';

const DEV = { APP_ENV: 'dev' };
const UNKNOWN = { custodyMode: null, spendFrom: null, lossLiability: null, reserve: null, funder: null };
const json = (v: object) => JSON.stringify({ ...UNKNOWN, ...v });

describe('custody mode switch: the partner holds the crypto, or the card pulls from the wallet (J-bank-29)', () => {
  it('reports each mode as the partner set it, and "not known" when it has not', () => {
    const holds = cardSimPartnerFor(json({ custodyMode: 'partner_holds' }), DEV);
    const pulls = cardSimPartnerFor(json({ custodyMode: 'wallet_pull' }), DEV);
    expect(cardSim({ partner: holds }).partnerTerms!().custodyMode).toBe('partner_holds');
    expect(cardSim({ partner: pulls }).partnerTerms!().custodyMode).toBe('wallet_pull');
    expect(custodyModeWords(holds)).toBe('The partner holds the crypto it spends');
    expect(custodyModeWords(pulls)).toBe('The card pulls from your own wallet');
    expect(custodyModeWords(cardSim().partnerTerms!())).toBe(NOT_KNOWN);
  });

  it('refuses a mode that is not one of the two', () => {
    expect(() => cardSimPartnerFor(json({ custodyMode: 'ledger' }), DEV)).toThrow(/not in shape/);
  });
});

describe('loss liability switch: unknown is "not known", never the partner (J-bank-15, J-bank-27 #4)', () => {
  it('an unknown bearer reads "not known" and is not reported as the partner', () => {
    const view = partnerTermsView(cardSim().partnerTerms!());
    expect(view.lossLiability).toBe(NOT_KNOWN);
    expect(view.lossLiabilityStatus).toBe('not_known');
    expect(view.lossLiability).not.toMatch(/partner/);
  });

  it('a reported bearer reads as the partner reported it, with its terms', () => {
    const terms = cardSimPartnerFor(json({ lossLiability: { bearer: 'programme', terms: 'TEST: the programme bears fraud losses' } }), DEV);
    const view = partnerTermsView(terms);
    expect(view.lossLiabilityStatus).toBe('reported');
    expect(view.lossLiability).toBe("the programme (INTAFACED), under the partner's terms: TEST: the programme bears fraud losses");
  });

  it('a bearer outside the closed set is refused, so a typo cannot become an answer', () => {
    expect(() => cardSimPartnerFor(json({ lossLiability: { bearer: 'nobody', terms: 'x' } }), DEV)).toThrow(/not in shape/);
  });
});

describe('programme reserve switch: unknown is "not known", never 0 (J-bank-26 #6)', () => {
  it('an unknown reserve and funder read "not known", with no digit in them', () => {
    const view = partnerTermsView(NOTHING_REPORTED);
    expect(view.reserve).toBe(NOT_KNOWN);
    expect(view.reserveStatus).toBe('not_known');
    expect(view.funder).toBe(NOT_KNOWN);
    expect(view.reserve).not.toMatch(/\d/);
  });

  it('a required reserve shows its amount; none required says so in words, not as 0', () => {
    const required = partnerTermsView(cardSimPartnerFor(json({ reserve: { required: true, amount: '25000.00', assetId: 'USDC' } }), DEV));
    expect(required.reserve).toBe('25000.00 USDC, as the partner reports');
    const none = partnerTermsView(cardSimPartnerFor(json({ reserve: { required: false } }), DEV));
    expect(none.reserve).toBe('None required, as the partner reports');
    expect(none.reserveStatus).toBe('reported');
  });

  it('a required reserve of zero is refused: a partner that requires none says required: false', () => {
    expect(() => cardSimPartnerFor(json({ reserve: { required: true, amount: '0.00', assetId: 'USDC' } }), DEV)).toThrow(/above zero/);
  });

  it('every key must be present: a missing reserve key never defaults', () => {
    expect(() => cardSimPartnerFor(JSON.stringify({ custodyMode: null, spendFrom: null, lossLiability: null, funder: null }), DEV)).toThrow(
      /reserve/,
    );
  });
});

describe('spend-from switch: an asset the partner cannot spend from is "not offered by the partner" (J-bank-29 #2)', () => {
  const owner = ['USDC', 'BTC', 'USD'];
  const partner: CardPartnerTerms = cardSimPartnerFor(json({ custodyMode: 'partner_holds', spendFrom: ['USDC', 'USD'] }), DEV);

  it('marks each owner asset offered or not offered from the partner list, then the person’s other card assets', () => {
    expect(payFromAssets(owner, partner, ['USDT', 'USDC'])).toEqual([
      { assetId: 'USDC', state: 'offered', words: 'offered by the partner' },
      { assetId: 'BTC', state: 'not_offered', words: NOT_OFFERED_BY_PARTNER },
      { assetId: 'USD', state: 'offered', words: 'offered by the partner' },
      { assetId: 'USDT', state: 'not_offered', words: NOT_OFFERED_BY_PARTNER },
    ]);
  });

  it('a partner asset the owner did not list is not offered to the person', () => {
    const wide = cardSimPartnerFor(json({ spendFrom: ['USDC', 'ETH'] }), DEV);
    expect(payFromAssets(['USDC'], wide, ['ETH'])).toEqual([
      { assetId: 'USDC', state: 'offered', words: 'offered by the partner' },
      { assetId: 'ETH', state: 'not_listed', words: 'not on the spendable list' },
    ]);
  });

  it('no partner list is "not known" for every asset, never an empty list read as "none offered"', () => {
    expect(payFromAssets(owner, NOTHING_REPORTED, []).map((a) => a.words)).toEqual([NOT_KNOWN, NOT_KNOWN, NOT_KNOWN]);
  });

  it('the owner list is the owner’s: blank or malformed refuses bank.card_spend_assets_unset', () => {
    expect(parseSpendAssets('USDC, BTC,USD')).toEqual(['USDC', 'BTC', 'USD']);
    for (const raw of [undefined, '', ' ', 'usdc', 'USDC,USDC', 'USDC,,BTC']) {
      expect(() => requireSpendAssets(parseSpendAssets(raw))).toThrow(expect.objectContaining({ code: 'bank.card_spend_assets_unset' }));
    }
  });
});

describe('production refusal (planted)', () => {
  const planted = json({ custodyMode: 'partner_holds', spendFrom: ['USDC'], reserve: { required: false } });

  it.each([
    { APP_ENV: 'staging' },
    { APP_ENV: 'prod' },
    { APP_ENV: 'production' },
    { APP_ENV: undefined },
    { APP_ENV: 'dev', NODE_ENV: 'production' },
    { APP_ENV: 'test', NODE_ENV: 'production' },
  ])('the TEST partner switches refuse to start under %o', (env) => {
    expect(() => cardSimPartnerFor(planted, env)).toThrow(/refuses to start outside APP_ENV=dev or test/);
  });

  it('card-sim with the switches planted in a prod posture is the not-live simulator, and its partner terms refuse', () => {
    const terms = cardSimPartnerFor(planted, DEV);
    for (const posture of [{ APP_ENV: 'prod' }, { APP_ENV: 'staging' }, { NODE_ENV: 'production' }]) {
      const adapter = cardIssuerFor('card-sim', posture, terms);
      expect(adapter.mutationRefuse).toBe('bank.card_sim_not_live');
      expect(() => adapter.partnerTerms!()).toThrow(expect.objectContaining({ code: 'bank.card_sim_not_live' }));
    }
  });

  it('with no issuer there is no partner to ask: bank.no_card_issuer', () => {
    expect(() => noCardIssuer.partnerTerms!()).toThrow(expect.objectContaining({ code: 'bank.no_card_issuer' }));
  });

  it('on a test posture the planted switches reach the simulator, labelled TEST', () => {
    const adapter = cardIssuerFor('card-sim', { live: false }, cardSimPartnerFor(planted, DEV));
    expect(adapter.partnerTerms!()).toMatchObject({ test: true, custodyMode: 'partner_holds', spendFrom: ['USDC'] });
  });

  it('unset switches start anywhere and report nothing', () => {
    expect(cardSimPartnerFor(undefined, { APP_ENV: 'prod' })).toEqual(NOTHING_REPORTED);
  });
});
