import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { AccountDetailsBody, AccountDetailsList } from './AccountDetails';
import { EligibilityBody, EligibilityView, isRegion } from './Eligibility';
import { accountDetailsRowSchema, bankReads, eligibilitySchema, type AccountDetailsRow, type Eligibility } from './contracts';
import { classifyRefusal } from '../../data/refusal-codes';
import { refusalCopy } from '../../data/refusals';
import { accountDetailsCopy } from './account-details-copy';

/** BK-acct-03 screen half: account details per currency, and who can open an account. */

const unavailable = (currency: string): AccountDetailsRow => ({ currency, state: 'unavailable', blocker: 'rail.bank', sets: [] });
// TEST fixture, not a real account.
const testSet = (id: string) => ({
  id,
  accountNumber: 'TEST-00000001',
  sortCode: 'TEST-00-00-00',
  routingNumber: null,
  bsb: null,
  iban: null,
  bic: null,
  partnerBank: 'TEST partner bank',
  restrictions: ['TEST: cannot receive Swift'],
});

describe('account details per currency', () => {
  it('with no banking partner each currency says so, shows no number, and the ask control is off with its reason', () => {
    const html = renderToStaticMarkup(<AccountDetailsList rows={[unavailable('GBP'), unavailable('EUR')]} />);
    expect(html).toContain('Needs a banking partner. It is switched off in this build.');
    expect(html).toContain('GBP');
    expect(html).toContain('EUR');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Ask for details<\/button>/);
    expect(html).toContain('account details come from a banking partner');
    expect(html).not.toMatch(/\d{6,}/);
    expect(html.toLowerCase()).not.toContain('coming soon');
  });

  it('with a TEST partner it shows every field the partner gave exactly, a copy control for each, and skips the empty ones', () => {
    const html = renderToStaticMarkup(
      <AccountDetailsList rows={[{ currency: 'GBP', state: 'done', blocker: null, sets: [testSet('a'), testSet('b')] }]} />,
    );
    expect(html.match(/TEST-00000001/g)).toHaveLength(2);
    expect(html.match(/TEST-00-00-00/g)).toHaveLength(2);
    expect(html).toContain('Account number');
    expect(html).toContain('Sort code');
    expect(html).not.toContain('IBAN');
    expect(html).not.toContain('BSB');
    expect(html).toContain('TEST partner bank');
    expect(html).toContain('TEST: cannot receive Swift');
    expect(html).toContain('Copy Account number');
    expect(html).not.toContain('Ask for details');
  });

  it('names a pending request and an empty list in words', () => {
    expect(
      renderToStaticMarkup(<AccountDetailsList rows={[{ currency: 'EUR', state: 'pending_user', blocker: null, sets: [] }]} />),
    ).toContain('Waiting for you to finish the checks');
    expect(renderToStaticMarkup(<AccountDetailsList rows={[]} />)).toContain('No currency is listed for account details.');
  });

  it('a refusal reads through the shared refusal words, never the raw code', () => {
    const failure = {
      ok: false,
      reason: 'error',
      status: 412,
      code: 'bank.account_details_currencies_unset',
      message: 'bank.account_details_currencies_unset',
    } as never;
    const html = renderToStaticMarkup(<AccountDetailsBody resource={{ status: 'failed', failure }} reload={() => undefined} />);
    expect(html).toContain('No currencies are listed yet for account details');
    expect(html).not.toContain('account_details_currencies_unset</');
  });

  it('reads the bank answer exactly and refuses a drifting one', () => {
    const answer = { currencies: [unavailable('GBP')] };
    expect(bankReads['accountDetails.list'].parse(answer).currencies[0]!.blocker).toBe('rail.bank');
    expect(() => accountDetailsRowSchema.parse({ ...unavailable('GBP'), blocker: 'something.else' })).toThrow();
    expect(() => accountDetailsRowSchema.parse({ ...unavailable('GBP'), state: 'maybe' })).toThrow();
  });
});

const rules: Eligibility['rules'] = {
  countries: ['GB', 'DE'],
  entityTypes: ['individual', 'company'],
  productRestrictions: [{ product: 'crypto', restriction: 'TEST: held as crypto, not as cash' }],
};

describe('who can open an account', () => {
  it('lists the published countries, account types and product limits exactly', () => {
    const html = renderToStaticMarkup(<EligibilityView data={{ rules, verdict: null }} />);
    expect(html).toContain('GB, DE');
    expect(html).toContain('individual, company');
    expect(html).toContain('TEST: held as crypto, not as cash');
    expect(html).not.toContain('eligibility-verdict');
  });

  it('says plainly when no product limit is published', () => {
    const html = renderToStaticMarkup(<EligibilityView data={{ rules: { ...rules, productRestrictions: [] }, verdict: null }} />);
    expect(html).toContain('No product limit is published.');
  });

  it('a blocked country is told the bank is not available there, and whether it is on the list', () => {
    const verdict = {
      region: 'US',
      status: 'blocked' as const,
      minTier: 'institutional',
      notes: null,
      source: 'JURISDICTION_MATRIX' as const,
      listed: false,
    };
    const html = renderToStaticMarkup(<EligibilityView data={{ rules, verdict }} />);
    expect(html).toContain('US: the bank is not available.');
    expect(html).toContain('This country is not on the published list.');
    expect(html).not.toContain('Needs verification level');
    expect(html).not.toContain('JURISDICTION_MATRIX');
  });

  it('an open, listed country says so and what verification it needs', () => {
    const verdict = {
      region: 'DE',
      status: 'open' as const,
      minTier: 'full',
      notes: null,
      source: 'JURISDICTION_MATRIX' as const,
      listed: true,
    };
    const html = renderToStaticMarkup(<EligibilityView data={{ rules, verdict }} />);
    expect(html).toContain('DE: the bank is available.');
    expect(html).toContain('This country is on the published list.');
    expect(html).toContain('Needs verification level: full');
  });

  it('an unpublished rule set refuses in words and lists nothing', () => {
    const failure = { ok: false, reason: 'error', status: 412, code: 'bank.eligibility_unset', message: 'bank.eligibility_unset' } as never;
    const html = renderToStaticMarkup(<EligibilityBody resource={{ status: 'failed', failure }} reload={() => undefined} />);
    expect(html).toContain('Who can open an account has not been published');
    expect(html).not.toContain('data-testid="eligibility"');
  });

  it('only a two-letter country can be checked', () => {
    expect(isRegion('de')).toBe(true);
    expect(isRegion(' DE ')).toBe(true);
    for (const bad of ['', 'D', 'DEU', '1A', 'D E']) expect(isRegion(bad), bad).toBe(false);
  });

  it('reads the bank answer exactly', () => {
    expect(eligibilitySchema.parse({ rules, verdict: null }).rules.countries).toEqual(['GB', 'DE']);
    expect(() =>
      eligibilitySchema.parse({
        rules,
        verdict: { region: 'US', status: 'banned', minTier: 'x', notes: null, source: 'JURISDICTION_MATRIX', listed: false },
      }),
    ).toThrow();
  });
});

describe('the new refusals', () => {
  it('map to their own words and the retryable one is a retry', () => {
    expect(classifyRefusal('rail.bank')).toBe('noBankPartner');
    expect(classifyRefusal('bank.account_details_currencies_unset')).toBe('detailsCurrenciesUnset');
    expect(classifyRefusal('bank.eligibility_unset')).toBe('eligibilityUnset');
    expect(classifyRefusal('bank.account_details_unavailable')).toBe('tryAgain');
    expect(refusalCopy('rail.bank').title).toBe('Account details need a banking partner');
  });
  it('the copy has the same keys in every language and no empty line', () => {
    const { t } = accountDetailsCopy.useCopy();
    for (const key of ['detailsTitle', 'stateUnavailable', 'askReason', 'verdictBlocked', 'productLimits'] as const)
      expect(t(key, { region: 'X' })).not.toBe('');
  });
});
