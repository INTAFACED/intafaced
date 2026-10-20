import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.stubGlobal('location', new URL('https://app.example.com/'));

import { SessionProvider } from '../session/session';
import { MoreRoutes } from './MoreRoutes';

const page = (path: string) =>
  renderToString(
    <SessionProvider>
      <MoreRoutes path={path} />
    </SessionProvider>,
  );

describe('More room sections and records (MC-order-01)', () => {
  it('shows a record with no data source as such, titled, with a way back to its room', () => {
    const html = page('/market/listing-9');
    expect(html).toContain('Market listing');
    expect(html).toContain('No details are shown for this record');
    expect(html).toContain('href="/market"');
  });

  it('refuses a malformed id without looking anything up', () => {
    expect(page('/market/a%2Fb')).toContain('That address is not valid');
    expect(page('/token/governance/%E0%A4%A')).toContain('That address is not valid');
  });

  it('opens a section inside its room under its own title', () => {
    const html = page('/mining/workers');
    expect(html).toContain('Mining workers');
    expect(html).not.toContain('No details are shown for this record');
  });

  it('keeps the honest "no customer route" panel for a path that is not a section or record', () => {
    expect(page('/market/a/b/c')).toContain('href="/more"');
  });
});
