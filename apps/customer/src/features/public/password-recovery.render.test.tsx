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

  it('shows the three steps in order and opens on the request step', () => {
    const first = page.indexOf('Ask for a reset code');
    const second = page.indexOf('Enter the code and a new password');
    const third = page.indexOf('Sign in</h2>');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(page).not.toContain('not switched on');
    expect(page).not.toContain('Nothing you see on this page is sent anywhere');
  });

  it('has one live email field and a send button, with nothing switched off', () => {
    const controls = page.match(/<(input|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBe(2);
    for (const control of controls) expect(control).not.toContain('disabled');
    expect(page).toContain('type="email"');
    expect(page).toMatch(/autocomplete="email"/i);
    expect(page).not.toContain('type="password"');
  });

  it('gives a signed-out visitor a way to reach a person that is not the sign-in-only support desk', () => {
    expect(page).toContain('href="mailto:');
    expect(page).not.toContain('href="/support"');
  });
});

describe('other public pages', () => {
  it('points at the inbox and help; the feed itself is read live and covered in notice-feed.render.test.tsx', () => {
    const page = html(<NoticePage />);
    expect(page).toContain('Notices');
    expect(page).toContain('/help');
  });

  it('says there is no store app and shows how to keep the web app on the home screen', () => {
    const page = html(<AppPage />);
    expect(page).toContain('There is no store app');
    expect(page).toContain('Add to Home Screen');
  });

  it('points a partner enquiry at an email draft when no invitation address is configured, and never at a fake form', () => {
    const page = html(<PartnerPage />);
    expect(page).toContain('href="mailto:');
    expect(page).toContain('/pay/merchant');
    expect(page).toContain('does not submit an application');
  });
});
