import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { Settings } from './Settings';
import { parsePortalRoute } from '../routes';
import { notLiveWords } from '../ui/test-words';
it('registers profile, security and notification settings routes', () => {
  expect(parsePortalRoute('/pay/settings')).toEqual({ room: 'settings' });
  expect(parsePortalRoute('/pay/settings/profile')).toEqual({ room: 'settings' });
  expect(parsePortalRoute('/pay/settings/security')).toEqual({ room: 'settings-security' });
  expect(parsePortalRoute('/pay/settings/team')).toBeNull();
  expect(parsePortalRoute('/pay/settings/notifications')).toEqual({ room: 'settings-notifications' });
  expect(parsePortalRoute('/pay/settings/unrecognized')).toBeNull();
});
it('does not substitute checkout configuration for a business identity update', () => {
  const out = renderToString(<Settings merchant={null} />);
  expect(out).toContain('update your business name');
  expect(out).toMatch(notLiveWords);
  expect(out).toMatch(/<button[^>]*disabled/);
  expect(out).not.toContain('<input');
});
it('shows only account facts supplied by the merchant read', () => {
  const out = renderToString(
    <Settings
      merchant={{
        id: 'TEST-merchant',
        userId: 'TEST-owner',
        mode: 'gateway',
        status: 'active',
        kybStatus: 'pending',
        kybRef: null,
        feeBps: null,
      }}
    />,
  );
  expect(out).toContain('TEST-merchant');
  expect(out).toContain('gateway');
  expect(out).not.toContain('verified business');
  expect(out).not.toContain('value="UTC"');
});
