import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// TEST data only. A personal account with no business and no two-step sign-in: its session carries neither pay:read
// nor pay:onboard, so the service answers 403 to every business read, merchant.me included.
const ME = '33333333-3333-4333-8333-333333333333';
const forbidden = {
  status: 'failed' as const,
  failure: { ok: false as const, reason: 'forbidden' as const, message: 'Forbidden', code: 'FORBIDDEN' },
};
vi.mock('../../../session/session', () => ({ useSession: () => ({ api: {}, userId: ME }) }));
vi.mock('../../../../shared/resource', () => ({
  useResource: () => ({ resource: forbidden, reload: () => undefined }),
}));

import { MerchantPortal } from '../MerchantPortal';
import { groups } from '../home-layout/groups';

const businessRooms = groups.flatMap((group) => group.items.map(([href]) => href));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
const tabs = (html: string) => html.slice(html.indexOf('data-testid="plo-tabs"'), html.indexOf('data-testid="pp"'));

describe('a personal account with no business and no pay:onboard', () => {
  for (const path of ['/pay/onboarding', '/pay/onboarding/business', '/pay/merchant', '/pay/payments', '/pay/settings/notifications']) {
    it(`the business menu on ${path} offers only "Open a business account", and no business room`, () => {
      const nav = tabs(renderToString(<MerchantPortal path={path} />));
      expect(nav).toContain('Open a business account');
      expect(hrefs(nav)).toEqual(['/pay/onboarding']);
      for (const room of businessRooms) expect(hrefs(nav)).not.toContain(room);
      expect(nav).not.toContain('plo-subtabs');
    });
  }

  for (const path of ['/pay/onboarding', '/pay/onboarding/business', '/pay/onboarding/verification', '/pay/onboarding/go-live']) {
    it(`setup on ${path} starts with turning on two-step sign-in, never a refusal or a raw reference`, () => {
      const out = renderToString(<MerchantPortal path={path} />);
      expect(out).toContain('First, turn on two-step sign-in');
      expect(out).toContain('href="/settings/security"');
      expect(out).not.toMatch(/You don’t have access|does not have access|Ask the account owner|Reference|Try again/);
    });
  }
});
