import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { PlanRuleText, overBalanceProblem, planRuleLine } from './PlanRule';
import type { ApiResult } from '../../shared/api';
import type { AccountTerms } from './contracts';
import { validateTransfer, type Space } from './client';

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
  overdraftBlocker: null,
  ...patch,
});
const ready = (data: AccountTerms) => ({ status: 'ready' as const, data });

describe('the plan rule for paying more than you hold', () => {
  it('a plan with no overdraft says payments above the balance are refused', () => {
    const html = renderToStaticMarkup(<PlanRuleText resource={ready(terms())} />);
    expect(html).toContain('Your plan, TEST base tier, has no overdraft: a payment cannot take your balance below zero.');
    expect(html).toContain('refused and nothing moves');
  });

  it('a plan with an overdraft names its fee and the bank blocker, and never claims a negative balance is shown', () => {
    const html = renderToStaticMarkup(
      <PlanRuleText resource={ready(terms({ overdraftFee: '0', overdraftBlocker: 'bank.overdraft_switched_off' }))} />,
    );
    expect(html).toContain('allows a negative balance at an overdraft fee of 0 USDT');
    expect(html).toContain('the overdraft is switched off in this build');
    expect(html).toContain('refused and nothing moves');
    expect(html).toContain('Reference: bank.overdraft_switched_off');
    expect(html).not.toContain('shows the negative balance');
  });

  it('the review of a payment above the balance names the shortfall, then the plan rule with its reference', () => {
    const overdraft = ready(terms({ tier: 'TEST plan', overdraftFee: '1', overdraftBlocker: 'bank.overdraft_switched_off' }));
    const from = { balance: '50', assetId: 'USDT' };
    expect(overBalanceProblem(overdraft, from, '60')).toBe(
      `This is 10 USDT more than this space holds (50 USDT). ${planRuleLine(overdraft)}`,
    );
    expect(planRuleLine(overdraft)).toContain('Reference: bank.overdraft_switched_off');
    // Exact to the last unit: 50.000001 is 0.000001 over.
    expect(overBalanceProblem(overdraft, from, '50.000001')).toContain('This is 0.000001 USDT more');
    // Within the balance, or not a readable amount, is not this check's to answer.
    expect(overBalanceProblem(overdraft, from, '50')).toBeNull();
    expect(overBalanceProblem(overdraft, from, 'lots')).toBeNull();
    // A plan with no overdraft: the shortfall and its own rule, no reference.
    const none = overBalanceProblem(ready(terms()), from, '60');
    expect(none).toContain('has no overdraft');
    expect(none).not.toContain('Reference');
    // Terms still loading: the shortfall alone, never a guessed rule.
    expect(overBalanceProblem({ status: 'loading' }, from, '60')).toBe('This is 10 USDT more than this space holds (50 USDT).');
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

describe('the transfer review uses the plan rule only for an amount above the balance', () => {
  const space = (patch: Partial<Space> = {}): Space => ({
    id: '11111111-1111-4111-8111-111111111111',
    assetId: 'USDT',
    kind: 'primary',
    name: 'Main',
    goalTarget: null,
    lockedUntil: null,
    balance: '50',
    ledgerAccount: { ownerType: 'user', ownerId: 'u', assetId: 'USDT', kind: 'available' },
    ...patch,
  });
  const draft = (from: Space, amount: string) => ({ transferId: 'review-reference', fromSpaceId: from.id, toUserId: 'someone', amount });
  const rule = () => 'THE PLAN RULE';

  it('over the balance: the plain refusal, then the plan rule; within it: no refusal; without a rule: the plain message', () => {
    const from = space();
    // The plain sentence stays first and whole (J-wallet-07 #2 reads it by name); the rule follows it.
    expect(validateTransfer([from], draft(from, '60'), rule)).toBe(
      'The amount exceeds the available quantity in this space. THE PLAN RULE',
    );
    expect(validateTransfer([from], draft(from, '50'), rule)).toBeNull();
    expect(validateTransfer([from], draft(from, '60'))).toContain('exceeds the available');
    expect(validateTransfer([from], draft(from, '60'), () => null)).toContain('exceeds the available');
  });

  it('a locked space is refused for being locked first, never for the overdraft', () => {
    const from = space({ lockedUntil: new Date(Date.now() + 86_400_000).toISOString() });
    const locked = validateTransfer([from], draft(from, '60'), rule);
    expect(locked).not.toContain('THE PLAN RULE');
    expect(locked).not.toContain('exceeds the available');
  });
});
