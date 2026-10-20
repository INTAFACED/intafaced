import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupportContact } from '../more/support-contact';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const hook = vi.hoisted(() => ({ value: null as unknown as SupportContact }));
vi.mock('../more/support-contact', async (original) => {
  const real = await original<typeof import('../more/support-contact')>();
  return { ...real, useSupportContact: () => hook.value };
});

import { SessionProvider } from '../session/session';
import { ContactSupport } from './ContactSupport';

const html = () =>
  renderToString(
    <SessionProvider>
      <ContactSupport />
    </SessionProvider>,
  );
const contact = (over: Partial<SupportContact> = {}): SupportContact => ({
  status: 'ready',
  email: null,
  phone: null,
  chatHours: null,
  ...over,
});
afterEach(() => vi.unstubAllEnvs());

describe('the contact card reads the owner-set details', () => {
  it('shows "not set" with no mailto, no phone and no hours when the owner has set nothing', () => {
    hook.value = contact();
    const page = html();
    expect(page).toContain('Support email is not set.');
    expect(page).not.toContain('mailto:');
    expect(page).not.toContain('data-testid="support-phone"');
    expect(page).not.toContain('data-testid="support-hours"');
  });

  it('shows the set email as the mail link, and the phone and chat hours when set', () => {
    hook.value = contact({ email: 'help@example.test', phone: '+49 30 1234 5678', chatHours: 'Mon to Fri, 09:00 to 17:00 UTC' });
    const page = html();
    expect(page).toContain('href="mailto:help@example.test?');
    expect(page).toContain('+49 30 1234 5678');
    expect(page).toContain('Mon to Fri, 09:00 to 17:00 UTC');
    expect(page).not.toContain('is not set');
  });

  it('does not say "not set" while the answer is still on its way', () => {
    hook.value = contact({ status: 'loading' });
    const page = html();
    expect(page).toContain('Loading contact details');
    expect(page).not.toContain('is not set');
  });

  it('says the details could not be read, and offers only the address the build holds', () => {
    hook.value = contact({ status: 'unread', email: 'build@example.test' });
    const page = html();
    expect(page).toContain('could not be read just now');
    expect(page).toContain('href="mailto:build@example.test?');
  });

  it('a failed read with no build address never claims the email is not set', () => {
    hook.value = contact({ status: 'unread', email: null });
    const page = html();
    expect(page).toContain('could not be read just now');
    expect(page).not.toContain('is not set');
    expect(page).not.toContain('mailto:');
  });
});
