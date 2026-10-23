import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('./preferences', async (original) => {
  const real = await original<typeof import('./preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { NOT_CONNECTED_CODES, ServiceOffNotice, serviceOffCopy } from './service-off';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");

describe('the shared service-off notice (HM-shell-03)', () => {
  it('says the one sentence with the allowlist code in the page and in data-not-connected', () => {
    const html = renderToString(<ServiceOffNotice code="vendor.push" action="Registering this device" />);
    expect(html).toContain('data-not-connected="vendor.push"');
    expect(text(html)).toBe('Registering this device needs a push delivery gateway. It is switched off in this build. vendor.push');
  });

  it('names an outside dependency for every allowlist code', () => {
    const { t } = serviceOffCopy.forLocale('en');
    for (const code of NOT_CONNECTED_CODES) expect(t(code), code).not.toBe(code);
  });

  it('takes only allowlist codes, so an own gap cannot borrow it', () => {
    // @ts-expect-error: our own missing back end is not on the allowlist.
    const own = <ServiceOffNotice code="svc.notify" action="Sending" />;
    expect(own).toBeTruthy();
  });
});
