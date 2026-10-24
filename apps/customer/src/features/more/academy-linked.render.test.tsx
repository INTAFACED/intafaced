import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { safeReturnTo } from '../../app/navigation';
import { SessionProvider } from '../session/session';
import { LinkedCourseEnrol } from './AcademyHub';
import { academyCourseHref, academyCourseSignInHref } from './academy-lms';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);

describe('a private link never rides into a URL (AC-catalogue-03)', () => {
  it('signs in back to the plain course address, with no #key in the redirect', () => {
    const out = html(<LinkedCourseEnrol slug="markets" state="published" signedIn={false} />);
    expect(out).toContain('href="/login?redirect=%2Facademy%2Flearning%2Fcourse%2Fmarkets"');
    expect(out).not.toMatch(/key|%23/);
    // The redirect is a room sign-in returns to, unchanged.
    expect(safeReturnTo(academyCourseHref('markets'))).toBe(academyCourseHref('markets'));
    expect(academyCourseSignInHref('a b')).toBe('/login?redirect=%2Facademy%2Flearning%2Fcourse%2Fa%2520b');
  });

  it('shows no sign-in when signed in, and the closed note while unpublished', () => {
    expect(html(<LinkedCourseEnrol slug="markets" state="published" signedIn />)).toBe('');
    const draft = html(<LinkedCourseEnrol slug="markets" state="draft" signedIn={false} />);
    expect(draft).toContain('This course is unpublished, so enrolment is closed.');
    expect(draft).not.toContain('/login');
  });
});
