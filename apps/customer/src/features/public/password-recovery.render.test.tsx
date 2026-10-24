import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// Server rendering runs no effects, so the support service never answers. This stands in for "it answered, and holds no
// address": the build address (VITE_SUPPORT_EMAIL, read at call time) is then the only source, as these tests expect.
vi.mock('../more/support-contact', async (original) => {
  const real = await original<typeof import('../more/support-contact')>();
  return {
    ...real,
    useSupportContact: () => real.mergeSupportContact({ ok: true, email: null, phone: null, chatHours: null }, real.supportContactEmail()),
  };
});

// Same for the outreach desk: by default it answered and holds no join address or terms; a test may set what it holds.
const partnerDesk = vi.hoisted(() => ({ read: { ok: true, joinUrl: null, partnerTerms: null, revision: 0 } as const as unknown }));
vi.mock('./partner-settings', async (original) => {
  const real = await original<typeof import('./partner-settings')>();
  return {
    ...real,
    usePartnerSettings: () =>
      real.mergePartnerSettings(partnerDesk.read as Parameters<typeof real.mergePartnerSettings>[0], import.meta.env.VITE_JOIN_URL),
  };
});

import { SessionProvider } from '../session/session';
import { PasswordRecovery } from './PasswordRecovery';
import { AppPage, NoticePage, PartnerPage } from './PublicPages';

const html = (node: React.ReactNode) => renderToString(<SessionProvider>{node}</SessionProvider>);
const TEST_ADDRESS = 'support@example.test';
afterEach(() => {
  vi.unstubAllEnvs();
  partnerDesk.read = { ok: true, joinUrl: null, partnerTerms: null, revision: 0 };
});

describe('/findPwd', () => {
  vi.stubEnv('VITE_SUPPORT_EMAIL', TEST_ADDRESS);
  const page = html(<PasswordRecovery />);
  vi.unstubAllEnvs();

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

  it('has one live email field, a send button and the forgot-handle button, with nothing switched off', () => {
    const controls = page.match(/<(input|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBe(3);
    expect(page).toContain('I forgot my handle');
    for (const control of controls) expect(control).not.toContain('disabled');
    expect(page).toContain('type="email"');
    expect(page).toMatch(/autocomplete="email"/i);
    expect(page).not.toContain('type="password"');
  });

  it('gives a signed-out visitor a way to reach a person that is not the sign-in-only support desk', () => {
    expect(page).toContain(`href="mailto:${TEST_ADDRESS}`);
    expect(page).not.toContain('href="/support"');
  });

  it('says the support email is not set, with no mailto link and no address, when none is published', () => {
    for (const blank of [undefined, '', '   ', 'not an address']) {
      vi.stubEnv('VITE_SUPPORT_EMAIL', blank);
      const unset = html(<PasswordRecovery />);
      expect(unset).toContain('Support email is not set.');
      expect(unset).not.toContain('mailto:');
      expect(unset).not.toContain('@');
    }
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
    vi.stubEnv('VITE_SUPPORT_EMAIL', TEST_ADDRESS);
    const page = html(<PartnerPage />);
    expect(page).toContain(`href="mailto:${TEST_ADDRESS}`);
    expect(page).toContain('/pay/merchant');
    expect(page).toContain('does not submit an application');
  });

  it('says the support email is not set on the partner page, with no mailto link, when none is published', () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', '');
    const page = html(<PartnerPage />);
    expect(page).toContain('Support email is not set');
    expect(page).not.toContain('mailto:');
    expect(page).toContain('Programme terms are not published.');
  });

  it("links the founders' join address and shows their programme terms when the outreach desk holds them", () => {
    vi.stubEnv('VITE_JOIN_URL', 'https://build.example.test');
    partnerDesk.read = { ok: true, joinUrl: 'https://join.example.test', partnerTerms: 'TEST terms\nsecond line', revision: 1 };
    const page = html(<PartnerPage />);
    expect(page).toContain('href="https://join.example.test/partner"');
    expect(page).not.toContain('build.example.test');
    expect(page).toContain('TEST terms');
    expect(page).not.toContain('Programme terms are not published');
  });

  it('keeps the build join address but says the terms could not be read when the outreach desk is unreachable', () => {
    vi.stubEnv('VITE_JOIN_URL', 'https://build.example.test');
    partnerDesk.read = { ok: false };
    const page = html(<PartnerPage />);
    expect(page).toContain('href="https://build.example.test/partner"');
    expect(page).toContain('The programme terms could not be read just now');
  });
});
