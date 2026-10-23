import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { AcademyCourseEnrolment } from '@intafaced/contracts/academy-catalogue';
import { SessionProvider } from '../session/session';
import { CourseEnrolView } from './AcademyCourseEnrol';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);
const terms: AcademyCourseEnrolment = {
  slug: 'markets',
  startsAt: null,
  seatCap: null,
  seatsRemaining: null,
  closed: null,
  tracks: [
    { track: 'audit', free: true, closed: null },
    { track: 'certificate', free: false, closed: 'no_price' },
  ],
  enrolment: null,
  activationMail: 'vendor.email',
};
const button = /<button[^>]*><span[^>]*>Enrol now<\/span><\/button>/;
const buttonOff = /<button[^>]*disabled=""[^>]*><span[^>]*>Enrol now/;
const view = (over: Partial<AcademyCourseEnrolment>, sending = false) =>
  html(<CourseEnrolView terms={{ ...terms, ...over }} sending={sending} refusal={null} onEnrol={() => undefined} />);

describe('course page Enrol now (AC-enrolment-01)', () => {
  it('offers the free track, keeps the unpriced certificate track closed with its reason, and says seats are not set', () => {
    const out = view({});
    expect(out).toContain('Self-paced: the course opens when you enrol.');
    expect(out).toContain('Not set');
    expect(out).not.toMatch(/\d+ of \d+ left/);
    expect(out).toMatch(/<input id="academy-enrol-markets-audit"[^>]*checked=""/);
    expect(out).not.toMatch(/<input id="academy-enrol-markets-audit"[^>]*disabled/);
    expect(out).toMatch(/<input id="academy-enrol-markets-certificate"[^>]*disabled=""/);
    expect(out).toContain('No price is set for this track, so it is closed for enrolment.');
    expect(out).toMatch(button);
    expect(out).not.toMatch(buttonOff);
    expect(out).not.toContain('academy.');
  });

  it('shows a seat count only when a cap exists, a start date when one is set, and a closed course in words', () => {
    const capped = view({ seatCap: 20, seatsRemaining: 3, startsAt: '2026-11-02T00:00:00.000Z' });
    expect(capped).toContain('3 of 20 left');
    expect(capped).toContain('Opens on November 2, 2026');
    const full = view({ closed: 'full', seatCap: 20, seatsRemaining: 0 });
    expect(full).toContain('Every seat is taken, so the course is closed for enrolment.');
    expect(full).toMatch(buttonOff);
  });

  it('turns the button off while one press is in flight', () => {
    expect(view({}, true)).toMatch(buttonOff);
  });

  it('once enrolled, says on which track and since when, and names the activation mail as switched off', () => {
    const out = view({ enrolment: { track: 'audit', enrolledAt: '2026-10-23T09:00:00.000Z' } });
    expect(out).toContain('You are enrolled on the Free track since October 23, 2026.');
    expect(out).toContain('data-not-connected="vendor.email"');
    expect(out).toContain('The activation mail needs an email delivery provider. It is switched off in this build.');
    expect(out).not.toContain('Enrol now');
  });
});
