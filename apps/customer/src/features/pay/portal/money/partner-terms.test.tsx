import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { Resource } from '../../../../shared/resource';
import { PartnerCurrencyNotes, PartnerInstantPayoutLine, PartnerReserveLine, PartnerShortfallLine } from './PartnerTerms';
import { partnerTermsSchema, type PartnerTerms } from './partner-terms-api';

// TEST DATA written for these tests: the TEST acquirer's answer, no real partner or amount.
const terms = (patch: Partial<PartnerTerms> = {}): Resource<PartnerTerms> => ({
  status: 'ready',
  data: partnerTermsSchema.parse({
    merchantId: '11111111-1111-4111-8111-111111111111',
    partner: 'TEST',
    asOf: '2026-11-09T00:00:00.000Z',
    reserveRule: { known: false },
    shortfallCover: { known: false },
    currencies: { known: false },
    instantPayout: { known: false },
    ...patch,
  }),
});
const text = (el: ReactElement) =>
  renderToString(el)
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;|’/g, "'");

describe("the acquiring partner's terms in the rooms (CUSTODY-DELTA §1.3: unknown, never zero)", () => {
  it('a term the partner has not given reads "not known", never 0', () => {
    for (const el of [
      <PartnerReserveLine terms={terms()} />,
      <PartnerShortfallLine terms={terms()} />,
      <PartnerInstantPayoutLine terms={terms()} test />,
    ]) {
      expect(text(el)).toMatch(/not known$/);
      expect(text(el)).not.toMatch(/\b0(\.0+)?\b/);
    }
    expect(text(<PartnerShortfallLine terms={terms()} />)).toBe('Who covers a shortfall: not known');
  });

  it('a feature the partner says it does not offer reads "not offered by the partner"', () => {
    expect(text(<PartnerInstantPayoutLine terms={terms({ instantPayout: { known: true, offered: false } })} test />)).toBe(
      'Instant payout: not offered by the partner',
    );
    expect(text(<PartnerCurrencyNotes terms={terms({ currencies: { known: true, offered: ['USDC'] } })} assets={['USDT', 'USDC']} />)).toBe(
      'USDT: not offered by the partner',
    );
  });

  it('an offered instant payout with no fee given reads its fee "not known"; a given fee is the partner\'s exact figure', () => {
    expect(
      text(<PartnerInstantPayoutLine terms={terms({ instantPayout: { known: true, offered: true, fee: { known: false } } })} test />),
    ).toBe("Instant payout: partner's fee not known");
    const given = text(
      <PartnerInstantPayoutLine
        terms={terms({ instantPayout: { known: true, offered: true, fee: { known: true, amount: '1.25', assetCode: 'USDT' } } })}
        test
      />,
    );
    expect(given).toContain("partner's fee");
    expect(given).toContain('1.25');
  });

  it('the partner\'s silence on currencies marks nothing, and an unreadable read never says "not known"', () => {
    expect(renderToString(<PartnerCurrencyNotes terms={terms()} assets={['USDT']} />)).toBe('');
    const failed: Resource<PartnerTerms> = { status: 'failed', failure: { ok: false, status: 503, code: 'x', message: 'x' } as never };
    expect(text(<PartnerReserveLine terms={failed} />)).toBe("Partner's reserve rule: Can't be read right now.");
  });

  it("a known reserve rule and cover read the partner's own words", () => {
    expect(text(<PartnerReserveLine terms={terms({ reserveRule: { known: true, rollingReserveBps: 500, holdDays: 30 } })} />)).toBe(
      "Partner's reserve rule: 5.00% of each settlement, for 30 days.",
    );
    expect(text(<PartnerShortfallLine terms={terms({ shortfallCover: { known: true, who: 'partner' } })} />)).toBe(
      'Who covers a shortfall: the partner, under its terms',
    );
  });
});
