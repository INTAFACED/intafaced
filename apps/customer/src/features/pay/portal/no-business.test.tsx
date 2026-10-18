import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { PortalApi } from './api';
import type { MerchantAccessValue } from './access/MerchantAccess';
import { PortalPage } from './MerchantPortal';
import { rooms } from './rooms';
import type { RoomContext } from './rooms-model';
import { PORTAL_ROOMS, parsePortalRoute, type PortalRoute } from './routes';

// TEST data only. A signed-in person who has no business account: the service says there is none.
const none: MerchantAccessValue = {
  access: { status: 'none' },
  merchant: { status: 'ready', data: null },
  team: { status: 'loading' },
  reloadMerchant: () => undefined,
  reload: () => undefined,
  can: () => false,
  canOwnerWrite: false,
  sessionScopes: null,
  moneyReason: () => 'off',
};
const ctx: RoomContext = { portal: {} as PortalApi, authority: null, access: none, starterFee: null };
const show = (route: PortalRoute) => renderToString(<PortalPage route={route} ctx={ctx} />);

/** Every portal address: each room once with an id, and the three setup steps. */
const routes: PortalRoute[] = [
  ...PORTAL_ROOMS.filter((room) => room !== 'onboarding').map((room): PortalRoute => ({ room, param: 'TEST-id' })),
  { room: 'onboarding' },
  { room: 'onboarding', step: 'business' },
  { room: 'onboarding', step: 'verification' },
  { room: 'onboarding', step: 'go-live' },
];

describe('a signed-in person with no business account', () => {
  it('walks every portal page', () => {
    expect(routes.length).toBeGreaterThan(55);
    expect(new Set(routes.map((r) => r.room))).toEqual(new Set(PORTAL_ROOMS));
  });

  for (const route of routes.filter((r) => r.room !== 'onboarding')) {
    const name = `${route.room}${route.param ? ' (detail)' : ''}`;
    it(`sees one calm "No business account yet" state on ${name}, never a refusal`, () => {
      const out = show(route);
      expect(out, name).toContain('No business account yet');
      expect(out).toContain('href="/pay/onboarding"');
      expect(out).toContain('Start setup');
      expect(out).not.toMatch(/not allowed|Try again|isn’t allowed|Page not found|forbidden/i);
    });
    it(`has nothing to press that cannot work on ${name}`, () => {
      const out = show(route);
      // Every button is switched off, and no link leads to a create form or a form on the page.
      for (const button of out.match(/<button\b[^>]*>/g) ?? []) expect(button, `${name}: ${button}`).toMatch(/\bdisabled\b/);
      expect(out).not.toMatch(/href="[^"]*\/new"|href="#(?:invite|request)"/);
    });
  }

  it('shows setup itself, so an account can be made there', () => {
    for (const route of routes.filter((r) => r.room === 'onboarding')) expect(show(route)).not.toContain('No business account yet');
  });

  it('switches the page’s create action off and says why', () => {
    const out = show({ room: 'links' });
    expect(out).toContain('Create a payment link');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>.*Create a payment link/s);
    expect(out).toContain('Needs a business account. Start setup first.');
    expect(out).not.toContain('href="/pay/links/new"');
  });

  it('can still answer a team invitation, because that is how a person joins a business', () => {
    const out = show({ room: 'team' });
    expect(out).toContain('No business account yet');
    expect(out).toMatch(/Loading|aria-busy/);
  });

  it('reads the same route table the app uses', () => {
    for (const path of ['/pay/links', '/pay/refunds/new', '/pay/payments/TEST-id', '/pay/reports/exports']) {
      const route = parsePortalRoute(path);
      expect(route, path).not.toBeNull();
      expect(show(route!), path).toContain('No business account yet');
    }
    expect(Object.keys(rooms)).toHaveLength(PORTAL_ROOMS.length);
  });
});
