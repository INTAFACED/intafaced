import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { CardSandboxAdapter } from './card-sandbox.js';
import { PARTNER_TERMS_NOT_KNOWN } from './rail-adapter.js';
import { assertRailPosture, testAcquirerSwitchesAllowed, SandboxRailError } from './posture.js';
import { RailRegistry } from './registry.js';
import { readPartnerTerms } from '../partner-terms.js';
import { MetricsError } from '../metrics/errors.js';

/**
 * The TEST acquirer's switches (CUSTODY-DELTA §4 row "TEST acquirer"; §1.3 "Unknown, never zero"; OWNER 226): per
 * business, the partner's reserve rule, who covers a chargeback shortfall, the currencies it offers and its instant
 * payout, each "not known" until the partner says; and a payout the destination sends back. Production refuses them.
 */
const SECRET = 'card-sandbox-partner-switches-secret-32ch';
const MERCHANT = '7b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e12';
const OTHER = '7b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e13';
const rail = () => new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });

/** A delivery signed the way the stack's `card-terms` command signs it. */
let clock = Date.now() - 60_000;
function termsReport(adapter: CardSandboxAdapter, body: Record<string, unknown>, occurredAt = new Date((clock += 1000)).toISOString()) {
  return adapter.signWebhook({ id: `terms:${String(body.merchantId)}:${occurredAt}`, type: 'partner.terms', occurredAt, ...body });
}

describe('TEST acquirer partner terms', () => {
  it('a business the partner has said nothing about reads every term "not known", never a zero', () => {
    expect(rail().partnerTerms(MERCHANT)).toEqual(PARTNER_TERMS_NOT_KNOWN);
    expect(readPartnerTerms([rail()], MERCHANT, { APP_ENV: 'test' }, new Date('2026-11-09T00:00:00Z'))).toEqual({
      merchantId: MERCHANT,
      partner: 'TEST',
      asOf: '2026-11-09T00:00:00.000Z',
      reserveRule: { known: false },
      shortfallCover: { known: false },
      currencies: { known: false },
      instantPayout: { known: false },
    });
  });

  it('a signed terms report sets one business, merged over what it said, and leaves another alone', () => {
    const a = rail();
    expect(a.receivePartnerTerms(termsReport(a, { merchantId: MERCHANT, terms: { currencies: { known: true, offered: ['USDT'] } } }))).toBe(
      'applied',
    );
    expect(
      a.receivePartnerTerms(
        termsReport(a, { merchantId: MERCHANT, terms: { instantPayout: { known: true, offered: true, fee: { known: false } } } }),
      ),
    ).toBe('applied');
    const read = readPartnerTerms([a], MERCHANT, { APP_ENV: 'test' });
    expect(read.currencies).toEqual({ known: true, offered: ['USDT'] });
    expect(read.instantPayout).toEqual({ known: true, offered: true, fee: { known: false } });
    expect(read.reserveRule).toEqual({ known: false });
    expect(read.shortfallCover).toEqual({ known: false });
    expect(a.partnerTerms(OTHER)).toEqual(PARTNER_TERMS_NOT_KNOWN);
  });

  it('a known fee is the partner\'s exact decimal, and "not offered" is the partner saying so', () => {
    const a = rail();
    a.setPartnerTerms(MERCHANT, {
      instantPayout: { known: true, offered: true, fee: { known: true, amount: parseAmount('1.25'), assetId: 'USDT' } },
      reserveRule: { known: true, rollingReserveBps: 500, holdDays: 90 },
      shortfallCover: { known: true, who: 'merchant' },
    });
    const read = readPartnerTerms([a], MERCHANT, { APP_ENV: 'test' });
    expect(read.instantPayout).toEqual({ known: true, offered: true, fee: { known: true, amount: '1.25', assetCode: 'USDT' } });
    expect(read.reserveRule).toEqual({ known: true, rollingReserveBps: 500, holdDays: 90 });
    expect(read.shortfallCover).toEqual({ known: true, who: 'merchant' });
    a.setPartnerTerms(MERCHANT, { instantPayout: { known: true, offered: false } });
    expect(readPartnerTerms([a], MERCHANT, { APP_ENV: 'test' }).instantPayout).toEqual({ known: true, offered: false });
  });

  it('refuses a report that is not signed, or that is malformed, whole', () => {
    const a = rail();
    const forged = new CardSandboxAdapter({ secret: 'some-other-secret-that-is-32-chars-long', toleranceSeconds: 300 });
    expect(
      a.receivePartnerTerms(termsReport(forged, { merchantId: MERCHANT, terms: { shortfallCover: { known: true, who: 'partner' } } })),
    ).toBe('not_terms');
    for (const terms of [
      { shortfallCover: { known: true, who: 'nobody' } },
      { reserveRule: { known: true, rollingReserveBps: 0.5, holdDays: 1 } },
      { instantPayout: { known: true, offered: true, fee: { known: true, amount: 1, assetId: 'USDT' } } },
      { currencies: { known: true, offered: ['usdt'] } },
      { reserveRule: { known: false, rollingReserveBps: 0 } },
      { somethingElse: { known: false } },
    ]) {
      expect(a.receivePartnerTerms(termsReport(a, { merchantId: MERCHANT, terms })), JSON.stringify(terms)).toBe('malformed');
    }
    expect(a.partnerTerms(MERCHANT)).toEqual(PARTNER_TERMS_NOT_KNOWN);
    // An ordinary delivery is not a terms report: it passes on to the core untouched.
    expect(a.receivePartnerTerms(a.signWebhook({ id: 'e1', type: 'captured', ref: 'ch_x' }))).toBe('not_terms');
  });

  it('a replayed or late report never overwrites newer terms', () => {
    const a = rail();
    const first = termsReport(a, { merchantId: MERCHANT, terms: { shortfallCover: { known: true, who: 'house' } } });
    const second = termsReport(a, { merchantId: MERCHANT, terms: { shortfallCover: { known: true, who: 'partner' } } });
    expect(a.receivePartnerTerms(first)).toBe('applied');
    expect(a.receivePartnerTerms(second)).toBe('applied');
    expect(a.receivePartnerTerms(first)).toBe('stale');
    expect(a.partnerTerms(MERCHANT).shortfallCover).toEqual({ known: true, who: 'partner' });
    const undated = a.signWebhook({ id: 't', type: 'partner.terms', merchantId: MERCHANT, terms: {} });
    expect(a.receivePartnerTerms(undated)).toBe('malformed');
  });

  it('outside dev and test a signed report is refused by name and changes nothing', () => {
    const a = rail();
    const report = termsReport(a, { merchantId: MERCHANT, terms: { shortfallCover: { known: true, who: 'house' } } });
    expect(a.receivePartnerTerms(report, { allowed: false })).toBe('refused');
    expect(a.partnerTerms(MERCHANT)).toEqual(PARTNER_TERMS_NOT_KNOWN);
  });

  it('a terms report is not a payment event: the ordinary webhook parser refuses it', () => {
    const a = rail();
    expect(a.verifyWebhook(termsReport(a, { merchantId: MERCHANT, ref: 'x', terms: {} }))).toBeNull();
  });
});

describe('TEST acquirer payout returned', () => {
  it('signs a payout.returned delivery for a payout it sent, with the returned amount the partner reports', async () => {
    const a = rail();
    const sent = await a.payout({
      settlementId: 's1',
      merchantId: MERCHANT,
      amount: parseAmount('100'),
      assetId: 'USDT',
      window: '2026-11-09',
      destination: { kind: 'bank', ref: 'acct' },
    });
    expect(sent.ok).toBe(true);
    const event = a.verifyWebhook(a.returnPayout('po_s1', parseAmount('99.5'), new Date(Date.now() - 2000)));
    expect(event).toMatchObject({ type: 'payout.returned', railRef: 'po_s1', amount: parseAmount('99.5'), assetId: 'USDT' });
    // A second, partial return is its own delivery, never a duplicate of the first.
    const again = a.verifyWebhook(a.returnPayout('po_s1', parseAmount('0.5'), new Date(Date.now() - 1000)));
    expect(again?.eventId).not.toBe(event?.eventId);
    expect(() => a.returnPayout('po_s1', parseAmount('100.01'))).toThrow(/at most what was paid out/);
    expect(() => a.returnPayout('po_nope', parseAmount('1'))).toThrow(/no payout/);
  });
});

describe('production refuses the TEST acquirer and its switches (planted)', () => {
  it('a prod config with the TEST acquirer registered and switched fails boot', () => {
    const a = rail();
    a.setPartnerTerms(MERCHANT, { shortfallCover: { known: true, who: 'partner' } });
    expect(() => assertRailPosture(new RailRegistry([a]), { APP_ENV: 'prod' })).toThrow(SandboxRailError);
    expect(() => assertRailPosture(new RailRegistry([a]), { APP_ENV: 'staging' })).toThrow(SandboxRailError);
  });

  it("even with the sandbox override, prod never reads or takes the TEST partner's terms", () => {
    const a = rail();
    a.setPartnerTerms(MERCHANT, { reserveRule: { known: true, rollingReserveBps: 500, holdDays: 90 } });
    const prod = { APP_ENV: 'prod', PAY_ALLOW_SANDBOX_RAILS: 'true', PAY_REGISTER_CARD_SANDBOX: 'true' };
    expect(() => assertRailPosture(new RailRegistry([a]), prod)).not.toThrow();
    expect(testAcquirerSwitchesAllowed(prod)).toBe(false);
    expect(() => readPartnerTerms([a], MERCHANT, prod)).toThrow(MetricsError);
    expect(() => readPartnerTerms([a], MERCHANT, prod)).toThrow('pay.partner_terms_unavailable');
    expect(testAcquirerSwitchesAllowed({ APP_ENV: 'test' })).toBe(true);
    expect(testAcquirerSwitchesAllowed({ APP_ENV: 'dev' })).toBe(true);
  });

  it('no acquiring partner registered: the read refuses, never "not known"', () => {
    expect(() => readPartnerTerms([], MERCHANT, { APP_ENV: 'test' })).toThrow('pay.partner_terms_unavailable');
  });
});
