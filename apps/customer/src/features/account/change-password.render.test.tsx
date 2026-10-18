import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import { ChangePassword } from './ChangePassword';

describe('change password card', () => {
  const page = renderToString(
    <SessionProvider>
      <ChangePassword />
    </SessionProvider>,
  );

  it('asks for the current password, the new one and a repeat, with the right browser hints', () => {
    expect(page).toContain('Current password');
    expect(page).toContain('Repeat the new password');
    expect(page.match(/autoComplete="current-password"/gi)).toHaveLength(1);
    expect(page.match(/autoComplete="new-password"/gi)).toHaveLength(2);
    expect(page.match(/type="password"/g)).toHaveLength(3);
  });

  it('states the rule the service enforces and the sign-out effect, and has one enabled submit', () => {
    expect(page).toContain('At least 12 characters, up to 72 bytes');
    expect(page).toContain('every other device is signed out');
    expect(page.match(/<button[^>]*type="submit"[^>]*>/g)).toHaveLength(1);
    expect(page).not.toMatch(/<button[^>]*disabled/);
  });
});
