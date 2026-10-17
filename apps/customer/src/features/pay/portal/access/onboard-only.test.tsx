import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// TEST data only. A session that may start a business (pay:onboard) but holds no pay:read: the service answers 403 to
// every read except merchant.me, which says there is no record.
const ME = '22222222-2222-4222-8222-222222222222';
const forbidden = {
  status: 'failed' as const,
  failure: { ok: false as const, reason: 'forbidden' as const, message: 'Forbidden', code: 'FORBIDDEN' },
};
vi.mock('../../../session/session', () => ({ useSession: () => ({ api: {}, userId: ME }) }));
vi.mock('../../../../shared/resource', () => ({
  useResource: (_load: unknown, key: string) => ({
    resource: key.includes('portal:merchant') ? { status: 'ready', data: null } : forbidden,
    reload: () => undefined,
  }),
}));

import { MerchantPortal } from '../MerchantPortal';
import { PortalFailure, RefusalOnceProvider } from '../components';

const rooms = [
  '/pay/merchant',
  '/pay/payments',
  '/pay/payments/aa000003-0000-4000-8000-000000000003',
  '/pay/links',
  '/pay/invoices',
  '/pay/subscriptions',
  '/pay/customers',
  '/pay/disputes',
  '/pay/refunds',
  '/pay/money',
  '/pay/payouts',
  '/pay/settlements',
  '/pay/approvals',
  '/pay/limits',
  '/pay/team',
  '/pay/developer/keys',
  '/pay/reports/exports',
];

describe('a session that holds only pay:onboard', () => {
  for (const path of rooms) {
    it(`sees "No business account yet" with a way to set up on ${path}, never a refusal or Try again`, () => {
      const out = renderToString(<MerchantPortal path={path} />);
      expect(out).toContain('No business account yet');
      expect(out).toContain('href="/pay/onboarding"');
      expect(out).not.toMatch(/Try again|Ask the account owner to change your role|does not have access|Your account does not/i);
      // said once, not once per panel
      expect(out.match(/No business account yet/g)?.length).toBe(1);
    });
  }
});

describe('a refusal for permission', () => {
  it('never offers Try again', () => {
    const out = renderToString(<PortalFailure result={forbidden.failure} retry={() => undefined} />);
    expect(out).toContain('Ask the account owner to change your role');
    expect(out).not.toContain('Try again');
  });
  it('still offers Try again for a failure that asking again can fix', () => {
    const out = renderToString(<PortalFailure result={{ ok: false, reason: 'unreachable', message: 'x' }} retry={() => undefined} />);
    expect(out).toContain('Try again');
  });
  it('is said once when one page shows the same refusal twice', () => {
    const out = renderToString(
      <RefusalOnceProvider>
        <PortalFailure result={forbidden.failure} />
        <PortalFailure result={forbidden.failure} />
        <PortalFailure result={{ ok: false, reason: 'unreachable', message: 'x' }} />
      </RefusalOnceProvider>,
    );
    expect(out.match(/Ask the account owner to change your role/g)?.length).toBe(1);
  });
});
