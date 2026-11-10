/**
 * The TEST partner card adapter's switches (CUSTODY-DELTA §4, row "TEST partner card"; §1.3 "Unknown, never zero").
 *
 * Each switch's "not known" or "not offered by the partner" path is asserted at the adapter, and the switches are planted
 * in a production config to see them refused (the way `rails/posture.ts` refuses sandbox rails).
 */
import { describe, expect, it } from 'vitest';
import { CardService } from './card-service.js';
import { cardIssuerFor, cardSim, noCardIssuer } from './issuer.js';
import {
  NOTHING_REPORTED,
  NOT_KNOWN,
  cardSimPartnerFor,
  parsePinTryLimit,
  parseSpendAssets,
  partnerTermsView,
  payFromAssets,
  requireSpendAssets,
  type CardPartnerTerms,
} from './partner-terms.js';

const DEV = { APP_ENV: 'dev' };
const UNKNOWN = {
  custodyMode: null,
  spendFrom: null,
  lossLiability: null,
  reserve: null,
  funder: null,
  balances: null,
  programmeFigures: null,
  figuresAsOf: null,
  fundingAssetId: null,
  fundingOffers: null,
};
const json = (v: object) => JSON.stringify({ ...UNKNOWN, ...v });

describe('custody mode switch: the partner holds the crypto, or the card pulls from the wallet (J-bank-29)', () => {
  it('reports each mode as the partner set it, and "not known" when it has not', () => {
    const holds = cardSimPartnerFor(json({ custodyMode: 'partner_holds' }), DEV);
    const pulls = cardSimPartnerFor(json({ custodyMode: 'wallet_pull' }), DEV);
    expect(cardSim({ partner: holds }).partnerTerms!().custodyMode).toBe('partner_holds');
    expect(cardSim({ partner: pulls }).partnerTerms!().custodyMode).toBe('wallet_pull');
    expect(cardSim().partnerTerms!().custodyMode).toBeNull();
    // The operator's words are in the third person: the cardholder's crypto, never "your" wallet.
    expect(partnerTermsView(holds).custodyMode).toBe('The partner holds the cardholder’s crypto and spends it');
    expect(partnerTermsView(pulls).custodyMode).toBe('The card pulls from the cardholder’s own wallet');
    expect(partnerTermsView(cardSim().partnerTerms!()).custodyMode).toBe(NOT_KNOWN);
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
    const required = partnerTermsView(
      cardSimPartnerFor(json({ figuresAsOf: 'now', reserve: { required: true, amount: '25000.00', assetId: 'USDC' } }), DEV),
    );
    expect(required.reserve).toBe('25000.00 USDC, as the partner reports');
    const none = partnerTermsView(cardSimPartnerFor(json({ figuresAsOf: 'now', reserve: { required: false } }), DEV));
    expect(none.reserve).toBe('None required, as the partner reports');
    expect(none.reserveStatus).toBe('reported');
  });

  it('b2 change 6: a reserve the partner sent with no time for it reads "not known", required or not', () => {
    for (const reserve of [{ required: true, amount: '25000.00', assetId: 'USDC' }, { required: false }]) {
      const view = partnerTermsView(cardSimPartnerFor(json({ reserve }), DEV));
      expect(view).toMatchObject({ reserve: NOT_KNOWN, reserveStatus: 'not_known' });
    }
  });

  it('b2 change 6: the partner time is now, an ISO time, or null; anything else refuses boot, and the limit is declared', () => {
    expect(cardSimPartnerFor(json({ figuresAsOf: '2026-11-10T08:00:00.000Z' }), DEV).figuresAsOf).toBe('2026-11-10T08:00:00.000Z');
    expect(cardSimPartnerFor(json({ figuresAsOf: 'now' }), DEV).figuresStaleAfterMs).toBeGreaterThan(0);
    expect(() => cardSimPartnerFor(json({ figuresAsOf: 'yesterday' }), DEV)).toThrow(/figuresAsOf/);
    const { figuresAsOf: _dropped, ...missing } = UNKNOWN;
    expect(() => cardSimPartnerFor(JSON.stringify(missing), DEV)).toThrow(/figuresAsOf/);
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
      { assetId: 'USDC', state: 'offered' },
      { assetId: 'BTC', state: 'not_offered' },
      { assetId: 'USD', state: 'offered' },
      { assetId: 'USDT', state: 'not_offered' },
    ]);
  });

  it('a partner asset the owner did not list is not offered to the person', () => {
    const wide = cardSimPartnerFor(json({ spendFrom: ['USDC', 'ETH'] }), DEV);
    expect(payFromAssets(['USDC'], wide, ['ETH'])).toEqual([
      { assetId: 'USDC', state: 'offered' },
      { assetId: 'ETH', state: 'not_listed' },
    ]);
  });

  it('no partner list is "not known" for every owner asset, never an empty list read as "none offered"', () => {
    expect(payFromAssets(owner, NOTHING_REPORTED, ['USDT']).map((a) => [a.assetId, a.state])).toEqual([
      ['USDC', 'not_known'],
      ['BTC', 'not_known'],
      ['USD', 'not_known'],
      // The owner never listed USDT: that answer is already final, whatever the partner has not said.
      ['USDT', 'not_listed'],
    ]);
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

  it('a leftover switch refuses boot even where the issuer is not card-sim (fail closed): index.ts reads it for every setting', () => {
    expect(() => cardSimPartnerFor(planted, { APP_ENV: 'staging' })).toThrow(/refuses to start/);
  });

  it('unset switches start anywhere and report nothing', () => {
    expect(cardSimPartnerFor(undefined, { APP_ENV: 'prod' })).toEqual(NOTHING_REPORTED);
  });
});

describe('Pay from names the real blocker first', () => {
  // The partner is asked before the owner's list, and before any read: a dead sql handle proves nothing was read.
  const noSql = (() => {
    throw new Error('Pay from read the database before naming its blocker');
  }) as unknown as ConstructorParameters<typeof CardService>[0];
  const ledger = {} as ConstructorParameters<typeof CardService>[1];

  it('no issuer and no owner list: bank.no_card_issuer, not the list', async () => {
    const cards = new CardService(noSql, ledger, { issuer: noCardIssuer, spendAssets: null });
    await expect(cards.payFrom('u')).rejects.toMatchObject({ code: 'bank.no_card_issuer' });
  });

  it('the simulator in a live deployment: bank.card_sim_not_live, not the list', async () => {
    const cards = new CardService(noSql, ledger, { issuer: cardIssuerFor('card-sim', { APP_ENV: 'prod' }), spendAssets: null });
    await expect(cards.payFrom('u')).rejects.toMatchObject({ code: 'bank.card_sim_not_live' });
  });

  it('card-sim on a test posture and no owner list: bank.card_spend_assets_unset', async () => {
    const cards = new CardService(noSql, ledger, { issuer: cardIssuerFor('card-sim', { live: false }), spendAssets: null });
    await expect(cards.payFrom('u')).rejects.toMatchObject({ code: 'bank.card_spend_assets_unset' });
  });
});

describe('the TEST partner card details, PIN and wallet switch (J-bank-14 #3, #4)', () => {
  it('offers TEST card details, PIN and wallet only with secrets: "test"; absent offers none', () => {
    const withSecrets = cardSim({ partner: cardSimPartnerFor(json({ secrets: 'test' }), DEV) });
    expect(withSecrets.testSecrets).toBe(true);
    expect(withSecrets.revealCredentials && withSecrets.setPin && withSecrets.verifyPin && withSecrets.provisionWallet).toBeTruthy();
    const without = cardSim({ partner: cardSimPartnerFor(json({}), DEV) });
    expect(without.testSecrets).toBeUndefined();
    expect(
      without.revealCredentials ?? without.revealPin ?? without.setPin ?? without.verifyPin ?? without.provisionWallet,
    ).toBeUndefined();
  });

  it('refuses any other secrets value, and the switch outside dev or test', () => {
    expect(() => cardSimPartnerFor(json({ secrets: 'live' }), DEV)).toThrow(/not in shape/);
    expect(() => cardSimPartnerFor(json({ secrets: 'test' }), { APP_ENV: 'prod' })).toThrow(/refuses to start/);
    expect(() => cardSimPartnerFor(json({ secrets: 'test' }), { APP_ENV: 'dev', NODE_ENV: 'production' })).toThrow(/refuses to start/);
  });

  it('the owner PIN try limit is a whole number 1 to 10, else not set', () => {
    expect(parsePinTryLimit('3')).toBe(3);
    expect(parsePinTryLimit(' 10 ')).toBe(10);
    for (const bad of [undefined, null, '', '0', '11', '2.5', '-1', 'three']) expect(parsePinTryLimit(bad)).toBeNull();
  });
});
