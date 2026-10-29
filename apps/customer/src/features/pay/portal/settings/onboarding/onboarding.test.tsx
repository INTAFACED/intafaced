import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import type { PortalApi } from '../../api';
import { parsePortalRoute } from '../../routes';
import type { KybEvent, MerchantRecord } from '../../schemas';
import type { Progress } from '../account/schemas';
import { failed, list, noop, plain, ready } from '../account/testing';
import { ComplianceView } from './Compliance';
import { OnboardingView, stepStates, type OnboardingViewProps } from './Onboarding';

const merchant: MerchantRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  mode: 'gateway',
  status: 'active',
  kybStatus: 'approved',
  kybRef: 'ref-1',
  feeBps: 150,
};
const progress = (patch: Partial<Progress> = {}): Progress => ({
  merchantId: merchant.id,
  business: { done: true, missing: [] },
  documents: { state: 'pending_vendor' },
  terms: { state: 'not_configured' },
  destination: { present: false, destinations: [] },
  kybStatus: 'none',
  merchantStatus: 'pending',
  blocking: ['documents_pending_vendor', 'terms_not_configured'],
  ...patch,
});
const base: OnboardingViewProps = {
  portal: {} as PortalApi,
  merchant: null,
  kyb: ready(null),
  progress: ready(null),
  history: null,
  loadMoreHistory: noop,
  rails: ready([{ id: 'crypto-native', capabilities: ['payout'], mode: 'sandbox' as const, usable: true, healthy: true }]),
  starterFee: { bps: 150, source: 'local_test' as const },
  saved: null,
  onCreated: noop,
  onKybSubmitted: noop,
  onDestinationSaved: noop,
  retry: noop,
};
const unconfirmed = { activation: 'unconfirmed', status: 'active', activatedAt: null, reason: 'no_activation_record' } as const;
const html = (props: Partial<OnboardingViewProps>) => renderToString(<OnboardingView {...base} {...props} />);

describe('setup overview', () => {
  it.each(['business', 'verification', 'go-live'] as const)('routes the %s step and keeps the overview', (step) => {
    expect(parsePortalRoute(`/pay/onboarding/${step}`)).toEqual({ room: 'onboarding', step });
    expect(parsePortalRoute('/pay/onboarding')).toEqual({ room: 'onboarding' });
    expect(parsePortalRoute('/pay/onboarding/unrecognised')).toBeNull();
  });
  it('is an overview, not the next form: three steps, what is left, what you can do now', () => {
    const out = html({ merchant: { ...merchant, status: 'pending', kybStatus: 'none' }, progress: ready(progress()) });
    expect(out).toContain('Step 1 of 3');
    expect(out).toContain('Step 3 of 3');
    expect(out).toContain('What is left');
    expect(out).toContain('What you can do now');
    expect(out).toContain('Send your verification reference for review');
    expect(out).not.toContain('Legal business name');
    expect(out).toContain('TEST VALUE');
    plain(out);
  });
  it('names the two genuine blockers: the document check and the terms', () => {
    const out = html({ merchant, progress: ready(progress()) });
    expect(out).toContain('Document checks are not connected here');
    expect(out).toContain('No terms of service to accept');
    expect(out).not.toContain('Coming soon');
  });
  it('lists what is missing from the business details when the service says so', () => {
    const out = html({ merchant, progress: ready(progress({ business: { done: false, missing: ['address'] } })) });
    expect(out).toContain('Your business details are missing: address.');
  });
  it('falls back to the account record when progress cannot be read', () => {
    const states = stepStates({
      merchant: { ...merchant, kybStatus: 'pending' },
      kyb: ready({ kybStatus: 'pending', kybRef: 'r', mode: 'gateway' }),
      progress: failed('pay.not_built', 501, 'not_supported'),
      saved: null,
    });
    expect(states.business).toBe('done');
    expect(states.verification).toBe('waiting');
    expect(states.destination).toBe(false);
  });
  it('uses the saved destinations the service reports', () => {
    const states = stepStates({
      merchant,
      kyb: ready(null),
      progress: ready(
        progress({
          destination: { present: true, destinations: [{ railId: 'bank', kind: 'bank', destinationMasked: '••••1234' }] },
          kybStatus: 'approved',
        }),
      ),
      saved: null,
    });
    expect(states.destination).toBe(true);
    expect(states.payout).toBe('done');
  });
});

describe('business step', () => {
  it('shows the grouped form and states that legal changes are reviewed', () => {
    const out = html({ step: 'business' });
    expect(out).toContain('Legal business name *');
    expect(out).toContain('Declared by you, not verified');
    expect(out).toContain('reviewed by INTAFACED');
    expect(out).toContain('Create my account');
    expect(out).not.toContain('Pricing is not set for this account');
  });
  it('names the starting fee as the blocker and keeps account creation off', () => {
    const out = html({ step: 'business', starterFee: null });
    expect(out).toContain('Pricing is not set for this account');
    expect(out).toContain('Opening new accounts isn’t possible here.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Create my account<\/button>/);
  });
  it('sends an existing account to the Business page to edit', () => {
    const out = html({ step: 'business', merchant });
    expect(out).toContain('href="/pay/settings"');
    expect(out).not.toContain('Create my account');
  });
});

describe('verification step', () => {
  it('needs step 1 first', () => {
    expect(html({ step: 'verification' })).toContain('Do step 1 first');
  });
  it('takes a reference, holds the business application, and shows history', () => {
    const out = html({
      step: 'verification',
      merchant: { ...merchant, status: 'pending', kybStatus: 'none', kybRef: null },
      kyb: ready({ kybStatus: 'none', kybRef: null, mode: 'gateway' }),
      history: list<KybEvent>([]),
    });
    expect(out).toContain('Verification file reference *');
    expect(out).toContain('Send for review');
    expect(out).toContain('Business application');
    expect(out).toContain('Tell INTAFACED what kind of business this is');
    expect(out).toContain('Nothing sent yet');
  });
  it('shows a pending review without a form to resubmit', () => {
    const out = html({
      step: 'verification',
      merchant: { ...merchant, status: 'pending', kybStatus: 'pending' },
      kyb: ready({ kybStatus: 'pending', kybRef: 'ref-9', mode: 'gateway' }),
      history: list<KybEvent>([]),
    });
    expect(out).toContain('INTAFACED is reviewing it');
    expect(out).not.toContain('Send for review');
  });
});

describe('go-live step', () => {
  const live = { step: 'go-live' as const, merchant: { ...merchant, status: 'pending' as const, kybStatus: 'pending' as const } };
  it('needs step 1 first', () => {
    expect(html({ step: 'go-live' })).toContain('Do step 1 first');
  });
  it('shows the saved destination masked, the live status and the terms blocker', () => {
    const out = html({
      ...live,
      progress: ready(
        progress({
          kybStatus: 'pending',
          destination: { present: true, destinations: [{ railId: 'bank-sandbox', kind: 'bank', destinationMasked: '••••4321' }] },
        }),
      ),
    });
    expect(out).toContain('••••4321');
    expect(out).toContain('Waiting for your verification to be approved');
    expect(out).toContain('No terms of service to accept');
    expect(out).toContain('TEST VALUE');
    expect(out).not.toContain('You are live');
  });
  it('names the missing payout method', () => {
    const out = html({ ...live, rails: ready([]) });
    expect(out).toContain('Payout method is not connected here');
  });
  it('says live payments wait for INTAFACED even once verified', () => {
    const out = html({ ...live, merchant, progress: ready(progress({ kybStatus: 'approved' })) });
    expect(out).toContain('Waiting for INTAFACED to switch it on');
  });
});

describe('compliance', () => {
  const history = {
    status: 'ready' as const,
    items: [
      {
        seq: '1',
        fromStatus: 'pending',
        toStatus: 'approved',
        kybRef: 'TEST',
        decidedBy: 'intafaced' as const,
        reason: 'INTERNAL NOTE MUST NOT DISPLAY',
        at: '2026-10-16T00:00:00Z',
      },
    ],
    hasMore: true,
    more: 'idle' as const,
  };
  it('routes compliance and rejects a made-up child path', () => {
    expect(parsePortalRoute('/pay/compliance')).toEqual({ room: 'compliance' });
    expect(parsePortalRoute('/pay/compliance/foreign')).toBeNull();
  });
  it('keeps verification separate from screening, never shows screening data, and hides internal notes', () => {
    const out = renderToString(
      <ComplianceView
        current={ready({ kybStatus: 'approved', kybRef: 'TEST-reference', mode: 'gateway' })}
        activation={ready(unconfirmed)}
        history={history}
        loadMore={noop}
        reload={noop}
      />,
    );
    expect(out).toContain('Approved');
    expect(out).toContain('Verification is not a screening result');
    expect(out).toContain('Results are not shown here');
    expect(out).toContain('TEST-reference');
    expect(out).toContain('Changed by INTAFACED');
    expect(out).toContain('Document checks are not connected here');
    expect(out).not.toContain('INTERNAL NOTE');
    expect(out).toContain('Load more');
  });
  it('reads activation as unconfirmed beside an approved verification, and never as a screening result', () => {
    const out = renderToString(
      <ComplianceView
        current={ready({ kybStatus: 'approved', kybRef: 'TEST-reference', mode: 'gateway' })}
        activation={ready(unconfirmed)}
        history={history}
        loadMore={noop}
        reload={noop}
      />,
    );
    const facts = out.slice(out.indexOf('data-testid="pp-activation"'));
    expect(facts).toContain('Unconfirmed');
    expect(facts).not.toContain('Activated');
    expect(out).toContain('has no recorded activation');
    expect(out).toContain('It is not a screening result');
    expect(out).not.toMatch(/screening (passed|cleared)|cleared/i);
  });
  it('shows a confirmed activation with its recorded time, and a failed read as a refusal that keeps the record', () => {
    const at = '2026-10-29T10:00:00.000Z';
    const confirmed = renderToString(
      <ComplianceView
        current={ready({ kybStatus: 'approved', kybRef: 'TEST-reference', mode: 'gateway' })}
        activation={ready({ activation: 'confirmed', status: 'active', activatedAt: at })}
        history={history}
        loadMore={noop}
        reload={noop}
      />,
    );
    expect(confirmed).toContain('Confirmed');
    expect(confirmed).toContain('Activated');
    expect(confirmed).toContain(`dateTime="${at}"`);
    const refused = renderToString(
      <ComplianceView
        current={ready({ kybStatus: 'approved', kybRef: 'TEST-reference', mode: 'gateway' })}
        activation={failed('pay.merchant_ops_not_merchant', 403)}
        history={history}
        loadMore={noop}
        reload={noop}
      />,
    );
    expect(refused).not.toContain('data-testid="pp-activation"');
    expect(refused).not.toContain('Confirmed');
    expect(refused).toContain('TEST-reference');
  });
  it('has a useful empty history and a loading state', () => {
    const out = renderToString(
      <ComplianceView
        current={{ status: 'loading' }}
        activation={{ status: 'loading' }}
        history={{ ...history, items: [], hasMore: false }}
        loadMore={noop}
        reload={noop}
      />,
    );
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('No verification history yet');
    expect(out).toContain('/pay/onboarding/verification');
  });
});
