import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// TEST data only: nobody here is real. The two reads the access provider makes are answered from `answers`.
const ME = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '11111111-1111-4111-8111-111111111111';
const answers: { myAccess: unknown; merchant: unknown } = { myAccess: null, merchant: null };
vi.mock('../session/session', () => ({ useSession: () => ({ api: {}, userId: ME }) }));
vi.mock('../../shared/resource', () => ({
  useResource: (_load: unknown, key: string) => ({
    resource: key.includes('my-access') ? answers.myAccess : key.includes('portal:merchant') ? answers.merchant : { status: 'loading' },
    reload: () => undefined,
  }),
}));

import { PayRoutes } from './PayRoutes';
import { featureById, isFeatureLive } from '../../app/feature-registry';

const ready = <T,>(data: T) => ({ status: 'ready' as const, data });
const owner = {
  merchantId: MERCHANT,
  role: 'owner',
  status: 'active',
  kybStatus: 'approved',
  verified: true,
  sessionInteractive: true,
  mode: 'gateway',
  displayName: 'TEST Coffee',
  legalName: 'TEST Coffee Ltd',
  capabilities: { 'payments.read': true },
  pricingVisibility: 'full',
};

/**
 * The normal app renders `<PayRoutes path>` under a signed-in session and nothing else: no `PayBusinessProvider` is mounted
 * anywhere. These pin that a signed-in person reaches the business rooms that way, and that someone with no business account
 * gets the one calm state with a way to start setup.
 */
describe('/pay rooms through the normal app (no PayBusinessProvider)', () => {
  it('shows "No business account yet" with Start setup to a signed-in person with no business', () => {
    answers.myAccess = ready({ memberships: [] });
    answers.merchant = ready(null);
    for (const path of ['/pay/merchant', '/pay/links', '/pay/payments', '/pay/money', '/pay/payouts/new', '/pay/approvals']) {
      const out = renderToString(<PayRoutes path={path} />);
      expect(out, path).toContain('No business account yet');
      expect(out, path).toContain('Start setup');
      expect(out, path).toContain('href="/pay/onboarding"');
      expect(out, path).not.toMatch(/No verified business account|Page not found/);
    }
  });

  it('opens the rooms for the owner of an approved business, with no refusal about a business account contract', () => {
    answers.myAccess = ready({ memberships: [owner] });
    answers.merchant = ready({
      id: MERCHANT,
      userId: ME,
      mode: 'gateway',
      status: 'active',
      kybStatus: 'approved',
      kybRef: null,
      feeBps: null,
    });
    for (const path of ['/pay/merchant', '/pay/links', '/pay/payments', '/pay/refunds', '/pay/payouts']) {
      const out = renderToString(<PayRoutes path={path} />);
      expect(out, path).toContain('Business navigation');
      expect(out, path).not.toContain('No business account yet');
      expect(out, path).not.toMatch(/No verified business account|Page not found|restricted/i);
    }
  });

  it('is listed as live in the feature registry, since its rooms open without a separate business provider', () => {
    expect(featureById('business-pay')?.status).toBe('live');
    expect(isFeatureLive('business-pay')).toBe(true);
  });
});
