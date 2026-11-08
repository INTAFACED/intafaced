import { describe, expect, it } from 'vitest';
import { BankError } from '../errors.js';
import { NOTHING_REPORTED } from '../cards/partner-terms.js';
import { cardTermsOrNone, partnerReservesRead } from './reserves.js';
import { testPartner } from './test-partner.js';

const NOW = new Date('2026-11-09T02:00:00.000Z');

describe('partnerReservesRead (J-ops-console-24 #1)', () => {
  it('reads the TEST partner bank and the TEST card partner as "not known", never zero or none', () => {
    expect(partnerReservesRead({ testPartner: testPartner(), cardTerms: NOTHING_REPORTED, now: NOW })).toEqual({
      asOf: NOW.toISOString(),
      partners: [
        { partner: 'bank', label: 'TEST partner bank', test: true, reserve: { status: 'not_known' } },
        { partner: 'card', label: 'TEST partner card', test: true, reserve: { status: 'not_known' } },
      ],
    });
  });

  it('keeps the programme reserve "not known" whatever one person switched their own reserve to', () => {
    const partner = testPartner();
    partner.set('11111111-1111-4111-8111-111111111111', { reserve: 'none' });
    expect(partnerReservesRead({ testPartner: partner, cardTerms: null, now: NOW }).partners).toEqual([
      { partner: 'bank', label: 'TEST partner bank', test: true, reserve: { status: 'not_known' } },
    ]);
  });

  it('carries a card partner reserve it reports, and one it says is not required', () => {
    const reported = { ...NOTHING_REPORTED, reserve: { required: true as const, amount: '25000.00', assetId: 'USDC' } };
    expect(partnerReservesRead({ testPartner: null, cardTerms: reported, now: NOW }).partners).toEqual([
      { partner: 'card', label: 'TEST partner card', test: true, reserve: { status: 'reported', assetId: 'USDC', amount: '25000.00' } },
    ]);
    const none = { ...NOTHING_REPORTED, reserve: { required: false as const } };
    expect(partnerReservesRead({ testPartner: null, cardTerms: none, now: NOW }).partners[0]!.reserve).toEqual({ status: 'none' });
  });

  it('lists no partner a deployment has no adapter for', () => {
    expect(partnerReservesRead({ testPartner: null, cardTerms: null, now: NOW }).partners).toEqual([]);
  });

  it('reads no card issuer as no card partner, and throws any other failure', () => {
    expect(
      cardTermsOrNone(() => {
        throw new BankError('none', 'bank.no_card_issuer');
      }),
    ).toBeNull();
    expect(() =>
      cardTermsOrNone(() => {
        throw new BankError('sim', 'bank.card_sim_not_live');
      }),
    ).toThrow('sim');
  });
});
