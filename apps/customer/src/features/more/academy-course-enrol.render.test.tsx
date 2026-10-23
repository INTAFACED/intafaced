import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { AcademyCourseEnrolment, AcademyCourseOutlineItem } from '@intafaced/contracts/academy-catalogue';
import { SessionProvider } from '../session/session';
import { CourseEnrolView } from './AcademyCourseEnrol';
import { AccessGrantsView, MyLearningView } from './AcademyMyLearning';
import { CourseOutlineView, outlineNeighbours } from './AcademyCourseOutline';

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
  html(
    <CourseEnrolView terms={{ ...terms, ...over }} sending={sending} refusal={null} onEnrol={() => undefined} onLeave={() => undefined} />,
  );

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
    // Leaving asks first: the first press only shows the confirmation.
    expect(out).toContain('Leave course');
    expect(out).not.toContain('Confirm leave');
  });
});

const course = {
  slug: 'markets' as const,
  status: 'in_progress' as const,
  enrolledAt: '2026-10-23T09:00:00.000Z',
  startsAt: null,
  items: 4,
  completed: 0,
  firstItemSlug: 'markets-one',
  resumeItemSlug: null,
};

describe('My learning and course access (AC-catalogue-02, AC-access-grants-01)', () => {
  it('offers Start course until something is read, then Continue at the resume item, with real counts', () => {
    const fresh = html(<MyLearningView courses={[course]} />);
    expect(fresh).toContain('0 of 4 items done');
    expect(fresh).toMatch(/href="\/academy\/markets-one"[^>]*>Start course</);
    expect(fresh).not.toContain('Continue');
    expect(fresh).toContain('No course completed.');
    expect(fresh).toContain('No course with a later start date.');
    const started = html(<MyLearningView courses={[{ ...course, completed: 1, resumeItemSlug: 'markets-two' }]} />);
    expect(started).toMatch(/href="\/academy\/markets-two"[^>]*>Continue</);
    expect(started).not.toContain('Start course');
    expect(html(<MyLearningView courses={[]} />)).toContain('You are not enrolled in any course.');
  });

  it('lists a free access record with no expiry, and says when there is none', () => {
    const out = html(<AccessGrantsView grants={[{ slug: 'markets', source: 'free', grantedAt: course.enrolledAt, expiresAt: null }]} />);
    expect(out).toContain('Free enrolment');
    expect(out).toContain('No expiry');
    expect(html(<AccessGrantsView grants={[]} />)).toContain('You have no course access records.');
  });
});

const row = (slug: string, over: Partial<AcademyCourseOutlineItem> = {}): AcademyCourseOutlineItem => ({
  slug,
  title: slug.toUpperCase(),
  kind: 'lesson',
  state: 'unlocked',
  lock: null,
  missing: [],
  opensAt: null,
  ...over,
});

describe('course outline (AC-course-structure-02)', () => {
  const items = [
    row('a', { state: 'completed' }),
    row('b'),
    row('c', { state: 'locked', lock: 'prerequisite', missing: ['b'] }),
    row('d', { state: 'locked', lock: 'window', opensAt: '2026-11-02T00:00:00.000Z' }),
    row('e'),
  ];

  it('Next and Previous skip locked items and count them', () => {
    expect(outlineNeighbours(items, 'b')).toEqual({ previous: { item: items[0], skipped: 0 }, next: { item: items[4], skipped: 2 } });
    expect(outlineNeighbours(items, 'a').previous).toEqual({ item: null, skipped: 0 });
    expect(outlineNeighbours(items, 'e').next).toEqual({ item: null, skipped: 0 });
  });

  it('types each item, gives a locked one its reason as text and no link, and marks the open one', () => {
    const out = html(<CourseOutlineView outline={{ slug: 'markets', items }} current="b" />);
    expect(out).toMatch(/<a href="\/academy\/b" aria-current="page"/);
    expect(out).not.toContain('href="/academy/c"');
    expect(out).not.toContain('href="/academy/d"');
    expect(out).toContain('Locked: complete B first.');
    expect(out).toContain('Locked: opens November 2, 2026.');
    expect(out).toContain('Completed');
    expect(out).toContain('Locked items skipped: 2');
    expect(out).toMatch(/href="\/academy\/e" rel="next"/);
  });

  it('a course that has not started says no item can be opened instead of offering Previous and Next', () => {
    const held = items.map((item) => ({ ...item, state: 'locked' as const, lock: 'window' as const, opensAt: '2026-11-02T00:00:00.000Z' }));
    const out = html(<CourseOutlineView outline={{ slug: 'markets', items: held }} current="a" />);
    expect(out).toContain('No item in this course can be opened now.');
    expect(out).not.toContain('This is the first item you can open.');
    expect(out).not.toContain('rel="next"');
  });
});
