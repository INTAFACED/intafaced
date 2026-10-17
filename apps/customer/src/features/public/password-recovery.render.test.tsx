import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import { PasswordRecovery } from './PasswordRecovery';
import { AppPage, NoticePage, PartnerPage } from './PublicPages';

const html = (node: React.ReactNode) => renderToString(<SessionProvider>{node}</SessionProvider>);

describe('/findPwd', () => {
  const page = html(<PasswordRecovery />);

  it('shows all three steps, in order, with the reason the journey is off', () => {
    const first = page.indexOf('Ask for a reset code');
    const second = page.indexOf('Enter the code');
    const third = page.indexOf('Choose a new password');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(page).toContain('Password reset is not switched on yet');
  });

  it('switches every field and button off', () => {
    const controls = page.match(/<(input|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThanOrEqual(6);
    for (const control of controls) expect(control).toContain('disabled');
  });

  it('gives a signed-out visitor a way to reach a person that is not the sign-in-only support desk', () => {
    expect(page).toContain('href="mailto:');
    expect(page).not.toContain('href="/support"');
  });
});

describe('other public pages', () => {
  it('says plainly that no public notices are published, and points at the inbox and help', () => {
    const page = html(<NoticePage />);
    expect(page).toContain('No public notices are published');
    expect(page).toContain('/help');
  });

  it('says there is no store app and shows how to keep the web app on the home screen', () => {
    const page = html(<AppPage />);
    expect(page).toContain('There is no store app yet');
    expect(page).toContain('Add to Home Screen');
  });

  it('points a partner enquiry at an email draft when no invitation address is configured, and never at a fake form', () => {
    const page = html(<PartnerPage />);
    expect(page).toContain('href="mailto:');
    expect(page).toContain('/pay/merchant');
    expect(page).toContain('does not submit an application');
  });
});
