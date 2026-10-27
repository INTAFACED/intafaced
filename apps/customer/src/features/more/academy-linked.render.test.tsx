import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { safeReturnTo } from '../../app/navigation';
import { SessionProvider } from '../session/session';
import { LinkedCourseEnrol } from './AcademyAuthoredCourse';
import { academyCourseHref, academyCourseSignInHref } from './academy-lms';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);

describe('a private link never rides into a URL (AC-catalogue-03)', () => {
  it('sends a published linked course to its plain public address, with no #key anywhere', () => {
    const out = html(<LinkedCourseEnrol slug="markets" state="published" />);
    expect(out).toContain('href="/academy/learning/course/markets"');
    expect(out).toContain('Open the course page to enrol');
    expect(out).not.toMatch(/key|%23|#/);
    // Sign-in from a course page returns to that plain address, a room sign-in returns to unchanged.
    expect(safeReturnTo(academyCourseHref('markets'))).toBe(academyCourseHref('markets'));
    expect(academyCourseSignInHref('a b')).toBe('/login?redirect=%2Facademy%2Flearning%2Fcourse%2Fa%2520b');
  });

  it('shows the closed note while unpublished, with no way to enrol', () => {
    const draft = html(<LinkedCourseEnrol slug="markets" state="draft" />);
    expect(draft).toContain('This course is unpublished, so enrolment is closed.');
    expect(draft).not.toContain('href=');
  });
});
