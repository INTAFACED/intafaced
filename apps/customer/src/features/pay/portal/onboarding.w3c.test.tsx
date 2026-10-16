import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { OnboardingView } from './Onboarding';
import type { PortalApi } from './api';
import { parsePortalRoute } from './routes';

const base: Parameters<typeof OnboardingView>[0] = {
  portal: {} as PortalApi,
  merchant: null,
  kyb: { status: 'ready', data: null } as const,
  history: null,
  loadMoreHistory: () => {},
  rails: { status: 'ready', data: [] },
  starterFeeBps: null,
  saved: null,
  onCreated: () => {},
  onKybSubmitted: () => {},
  onDestinationSaved: () => {},
  retry: () => {},
};
it.each(['business', 'verification', 'go-live'] as const)('routes the %s step directly and preserves the overview', (step) => {
  expect(parsePortalRoute(`/pay/onboarding/${step}`)).toEqual({ room: 'onboarding', step });
  expect(parsePortalRoute('/pay/onboarding')).toEqual({ room: 'onboarding' });
  expect(parsePortalRoute('/pay/onboarding/unrecognised')).toBeNull();
});
it('refuses account creation without a published starting fee and discloses draft persistence', () => {
  const out = renderToString(<OnboardingView {...base} step="business" />);
  expect(out).toContain('open your business account here soon');
  expect(out).toContain('save your business details and finish setting up later');
  expect(out).toMatch(/disabled=""[^>]*>Create my account/);
});
it.each(['verification', 'go-live'] as const)('does not allow %s to bypass business creation', (step) => {
  const out = renderToString(<OnboardingView {...base} step={step} />);
  expect(out).toContain('Do step 1 first');
  expect(out).not.toContain('Create my account');
});
it('does not claim activation from an in-memory saved destination', () => {
  const out = renderToString(
    <OnboardingView
      {...base}
      step="go-live"
      merchant={{ id: 'TEST', userId: 'TEST', mode: 'gateway', status: 'pending', kybStatus: 'none', kybRef: null, feeBps: null }}
      saved={{ railId: 'TEST', ref: 'TEST', kind: 'bank' }}
    />,
  );
  expect(out).toContain('turn on live payments');
  expect(out).not.toContain('Ready for test payments');
});
