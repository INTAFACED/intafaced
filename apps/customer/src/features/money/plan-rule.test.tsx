import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { PlanRuleText } from './PlanRule';
import type { ApiResult } from '../../shared/api';
import type { AccountTerms } from './contracts';

type Refusal = Extract<ApiResult<AccountTerms>, { ok: false }>;
const failed = (failure: Refusal) => ({ status: 'failed' as const, failure });

/** BK-xfer-05 negative-balance half (J-bank-02 #8): the plan's rule for paying more than the balance holds. */

const terms = (patch: Partial<AccountTerms> = {}): AccountTerms => ({
  tier: 'TEST base tier',
  version: 'local-test-1',
  currency: 'USDT',
  monthlyFee: '0',
  minimumBalance: '0',
  overdraftFee: null,
  included: [],
  ...patch,
});
const ready = (data: AccountTerms) => ({ status: 'ready' as const, data });

describe('the plan rule for paying more than you hold', () => {
  it('a plan with no overdraft says payments above the balance are refused', () => {
    const html = renderToStaticMarkup(<PlanRuleText resource={ready(terms())} />);
    expect(html).toContain('Your plan, TEST base tier, has no overdraft: a payment cannot take your balance below zero.');
    expect(html).toContain('refused and nothing moves');
  });

  it('a plan with an overdraft names its fee, an overdraft that costs nothing included', () => {
    expect(renderToStaticMarkup(<PlanRuleText resource={ready(terms({ overdraftFee: '0' }))} />)).toContain(
      'allows a negative balance at an overdraft fee of 0',
    );
  });

  it('unpublished terms assume nothing; another failure is shown as the failure it is', () => {
    const unset = renderToStaticMarkup(
      <PlanRuleText resource={failed({ ok: false, reason: 'error', code: 'bank.account_terms_unset', message: 'x' })} />,
    );
    expect(unset).toContain('The bank has published no plan terms');
    expect(unset).toContain('bank.account_terms_unset');
    const other = renderToStaticMarkup(<PlanRuleText resource={failed({ ok: false, reason: 'error', message: 'Bank is down' })} />);
    expect(other).not.toContain('published no plan terms');
    const company = renderToStaticMarkup(
      <PlanRuleText resource={failed({ ok: false, reason: 'error', code: 'bank.company_account_unwired', message: 'x' })} />,
    );
    expect(company).toContain('A business has no account of its own in this build');
  });
});
