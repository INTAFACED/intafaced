import { describe, expect, it } from 'vitest';
import { ACADEMY_RESERVED_TAB_SLUGS } from '@intafaced/contracts';
import {
  academyVerifyHref,
  certificateState,
  issueWait,
  buildTracking,
  certificateCards,
  certificateDocument,
  certificateLessons,
  certificateState,
  emptyTracking,
  groupByPath,
  lessonHrefFor,
  lessonStatus,
  formatMoment,
  neighbours,
  nextUp,
  parseVerifyCode,
  parseVerifyReference,
  pathProgress,
  readLastLesson,
  rememberLastLesson,
  resumeTarget,
  roomSummary,
  academyAssignmentHref,
  academyCourseHref,
  academyRoute,
  academySectionRedirect,
  academyTabHref,
  academyTabs,
  type CertDefinition,
  type CertGrant,
  type CertProgressRow,
  type LessonSummary,
} from './academy-lms';
import { academyLmsCopy } from './academy-lms-copy';

const owner = '11111111-1111-4111-8111-111111111111';
const lesson = (
  slug: string,
  path: LessonSummary['path'],
  order: number,
  minutes = 10,
  kind: LessonSummary['kind'] = 'lesson',
): LessonSummary => ({
  slug,
  title: `Title ${slug}`,
  kind,
  path,
  order,
  summary: '',
  estimatedMinutes: minutes,
});
const lessons = [
  lesson('f-3', 'foundations', 3),
  lesson('f-1', 'foundations', 1, 10, 'playbook'),
  lesson('f-2', 'foundations', 2, 20, 'workbook'),
  lesson('m-1', 'markets', 1, 5),
  lesson('s-1', 'sovereign', 1, 7),
];
const definition: CertDefinition = { id: 'foundations-v1', title: 'Foundations', requiredItemSlugs: ['f-1', 'f-2'] };
const progress = (missing: string[], over: Partial<CertProgressRow> = {}): CertProgressRow => ({
  userId: owner,
  certId: definition.id,
  title: 'Foundations',
  requiredCount: 2,
  completedCount: 2 - missing.length,
  ratio: ((2 - missing.length) / 2).toFixed(4),
  missingItemSlugs: missing,
  complete: missing.length === 0,
  granted: false,
  grantIdempotencyKey: null,
  ...over,
});
const grant: CertGrant = {
  userId: owner,
  certId: definition.id,
  grantedAt: '2026-10-10T08:00:00.000Z',
  idempotencyKey: `cert:${owner}:${definition.id}`,
};

const completion = (itemSlug: string) => ({ itemSlug, completedAt: '2026-10-11T09:00:00.000Z' });

describe('tracking and lesson status', () => {
  it('reads recorded and pending from certificate progress, and everything else as open', () => {
    const tracking = buildTracking([definition], [progress(['f-2'])], []);
    expect(lessonStatus('f-1', tracking)).toBe('recorded');
    expect(lessonStatus('f-2', tracking)).toBe('pending');
    expect(lessonStatus('f-3', tracking)).toBe('open');
    expect(lessonStatus('anything', emptyTracking)).toBe('open');
  });

  it('records any lesson Academy lists as completed, whether or not a certificate requires it', () => {
    const tracking = buildTracking([definition], [progress(['f-2'])], [], [completion('f-3'), completion('m-1')]);
    expect(lessonStatus('f-3', tracking)).toBe('recorded');
    expect(lessonStatus('m-1', tracking)).toBe('recorded');
    expect(lessonStatus('f-2', tracking)).toBe('pending');
    expect(lessonStatus('s-1', tracking)).toBe('open');
  });

  it('does not leave a completed lesson pending for a certificate', () => {
    const tracking = buildTracking([definition], [progress(['f-2'])], [], [completion('f-2')]);
    expect(lessonStatus('f-2', tracking)).toBe('recorded');
    expect(tracking.pending.has('f-2')).toBe(false);
  });

  it('treats a lesson recorded for one certificate as recorded for the account', () => {
    const other: CertDefinition = { id: 'other', title: 'Other', requiredItemSlugs: ['f-2'] };
    const tracking = buildTracking(
      [definition, other],
      [progress([]), progress(['f-2'], { certId: 'other', requiredCount: 1, completedCount: 0 })],
      [],
    );
    expect(lessonStatus('f-2', tracking)).toBe('recorded');
  });

  it('ignores a definition that has no progress answer', () => {
    const tracking = buildTracking([definition], [], []);
    expect(lessonStatus('f-1', tracking)).toBe('open');
  });
});

describe('paths and progress', () => {
  it('groups by path in the service order and sums minutes', () => {
    const groups = groupByPath(lessons);
    expect(groups.map((g) => g.path)).toEqual(['foundations', 'markets', 'sovereign']);
    expect(groups[0]!.lessons.map((l) => l.slug)).toEqual(['f-1', 'f-2', 'f-3']);
    expect(groups[0]).toMatchObject({ minutes: 40, playbooks: 1, workbooks: 1, readings: 1 });
  });

  it('shows 0 percent for a path with nothing completed, and no percentage for a path with no lessons', () => {
    const marketsOnly = lessons.filter((l) => l.path === 'markets');
    const tracking = buildTracking([definition], [progress(['f-2'])], []);
    expect(pathProgress(marketsOnly, tracking)).toEqual({ total: 1, recorded: 0, pending: 0, open: 1, percent: 0 });
    expect(pathProgress([], tracking)).toMatchObject({ total: 0, percent: null });
  });

  it('counts every lesson in the path and floors the percentage', () => {
    const inPath = groupByPath(lessons)[0]!.lessons;
    const tracking = buildTracking([definition], [progress(['f-2'])], []);
    expect(pathProgress(inPath, tracking)).toEqual({ total: 3, recorded: 1, pending: 1, open: 1, percent: 33 });
    const withCompletion = buildTracking([definition], [progress(['f-2'])], [], [completion('f-3')]);
    expect(pathProgress(inPath, withCompletion)).toEqual({ total: 3, recorded: 2, pending: 1, open: 0, percent: 66 });
    const all = buildTracking([definition], [progress([])], [], [completion('f-3')]);
    expect(pathProgress(inPath, all).percent).toBe(100);
  });

  it('finds previous and next within a path and tolerates an unknown slug', () => {
    const inPath = groupByPath(lessons)[0]!.lessons;
    expect(neighbours(inPath, 'f-2')).toMatchObject({ previous: { slug: 'f-1' }, next: { slug: 'f-3' }, position: 2, total: 3 });
    expect(neighbours(inPath, 'f-1').previous).toBeNull();
    expect(neighbours(inPath, 'f-3').next).toBeNull();
    expect(neighbours(inPath, 'nope')).toEqual({ previous: null, next: null, position: 0, total: 3 });
  });

  it('offers the first pending lesson, then the first one not completed, then nothing', () => {
    const inPath = groupByPath(lessons)[0]!.lessons;
    expect(nextUp(inPath, buildTracking([definition], [progress(['f-2'])], []))?.slug).toBe('f-2');
    expect(nextUp(inPath, buildTracking([definition], [progress([])], []))?.slug).toBe('f-3');
    const all = buildTracking(
      [{ ...definition, requiredItemSlugs: ['f-1', 'f-2', 'f-3'] }],
      [progress([], { requiredCount: 3, completedCount: 3 })],
      [],
    );
    expect(nextUp(inPath, all)).toBeNull();
    expect(nextUp([], emptyTracking)).toBeNull();
  });
});

describe('resume', () => {
  const tracking = buildTracking([definition], [progress(['f-2'])], []);
  it('returns the last opened lesson while it is not recorded', () => {
    expect(resumeTarget('f-2', lessons, tracking)).toMatchObject({ reason: 'unfinished', lesson: { slug: 'f-2' } });
    expect(resumeTarget('f-3', lessons, tracking)).toMatchObject({ reason: 'unfinished', lesson: { slug: 'f-3' } });
  });
  it('moves to the next lesson in the path after a recorded one', () => {
    expect(resumeTarget('f-1', lessons, tracking)).toMatchObject({ reason: 'after-last', lesson: { slug: 'f-2' } });
  });
  it('falls back to the next required lesson, then to the first lesson', () => {
    expect(resumeTarget(null, lessons, tracking)).toMatchObject({ reason: 'required', lesson: { slug: 'f-2' } });
    expect(resumeTarget('gone-from-catalogue', lessons, tracking)).toMatchObject({ reason: 'required' });
    expect(resumeTarget(null, lessons, emptyTracking)).toMatchObject({ reason: 'start', lesson: { slug: 'f-1' } });
    expect(resumeTarget(null, [], emptyTracking)).toBeNull();
  });
  it('falls back when the last recorded lesson ends its path', () => {
    const done = buildTracking(
      [{ ...definition, requiredItemSlugs: ['m-1'] }],
      [progress([], { requiredCount: 1, completedCount: 1 })],
      [],
    );
    expect(resumeTarget('m-1', lessons, done)).toMatchObject({ reason: 'start' });
  });
});

describe('last-lesson storage', () => {
  const memory = () => {
    const bytes = new Map<string, string>();
    return { getItem: (k: string) => bytes.get(k) ?? null, setItem: (k: string, v: string) => void bytes.set(k, v) };
  };
  it('remembers per account and ignores a missing account', () => {
    const store = memory();
    rememberLastLesson(owner, 'f-2', store);
    expect(readLastLesson(owner, store)).toBe('f-2');
    expect(readLastLesson('22222222-2222-4222-8222-222222222222', store)).toBeNull();
    rememberLastLesson(null, 'x', store);
    expect(readLastLesson(null, store)).toBeNull();
  });
  it('survives storage that throws or is absent', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => rememberLastLesson(owner, 'f-2', broken)).not.toThrow();
    expect(readLastLesson(owner, broken)).toBeNull();
    expect(readLastLesson(owner, null)).toBeNull();
  });
  it('refuses an oversized stored value', () => {
    const store = memory();
    store.setItem(`intafaced:academy:last-lesson:${owner}`, 'x'.repeat(121));
    expect(readLastLesson(owner, store)).toBeNull();
  });
});

describe('certificates', () => {
  it('derives each state from service facts only', () => {
    expect(certificateState(undefined, undefined)).toBe('not-started');
    expect(certificateState(progress(['f-1', 'f-2']), undefined)).toBe('not-started');
    expect(certificateState(progress(['f-2']), undefined)).toBe('in-progress');
    expect(certificateState(progress([]), undefined)).toBe('ready');
    expect(certificateState(progress([]), grant)).toBe('earned');
    expect(certificateState(progress([], { granted: true, grantIdempotencyKey: grant.idempotencyKey }), undefined)).toBe('earned');
  });

  it('builds one card per definition with a real percentage', () => {
    const tracking = buildTracking([definition], [progress(['f-2'])], []);
    const [card] = certificateCards(tracking);
    expect(card).toMatchObject({ state: 'in-progress', percent: 50 });
    expect(certificateLessons(card!, lessons)).toEqual([
      { slug: 'f-1', lesson: lessons.find((l) => l.slug === 'f-1'), recorded: true },
      { slug: 'f-2', lesson: lessons.find((l) => l.slug === 'f-2'), recorded: false },
    ]);
  });

  it('issues a document only for an earned certificate, from the grant', () => {
    const earned = certificateCards(buildTracking([definition], [progress([])], [grant]))[0]!;
    expect(certificateDocument(earned, owner)).toEqual({
      title: 'Foundations',
      certId: 'foundations-v1',
      holder: owner,
      issuedAt: grant.grantedAt,
      reference: grant.idempotencyKey,
      code: null,
      requirements: 2,
    });
    const coded = certificateCards(buildTracking([definition], [progress([])], [{ ...grant, publicId: 'a'.repeat(32) }]))[0]!;
    expect(certificateDocument(coded, owner)?.code).toBe('a'.repeat(32));
    const ready = certificateCards(buildTracking([definition], [progress([])], []))[0]!;
    expect(certificateDocument(ready, owner)).toBeNull();
  });

  it('tells a verification code from a grant reference and from anything else', () => {
    const code = '0123456789abcdef0123456789abcdef';
    expect(parseVerifyCode(` ${code} `)).toEqual({ kind: 'code', code });
    expect(parseVerifyCode(code.toUpperCase())).toEqual({ kind: 'code', code });
    expect(parseVerifyCode(`cert:${owner}:foundations-v1`)).toEqual({ kind: 'grant-reference' });
    for (const bad of ['', code.slice(1), `${code}0`, `${code.slice(1)}g`, 'foundations-v1'])
      expect(parseVerifyCode(bad)).toEqual({ kind: 'invalid' });
  });

  it('parses a grant reference and rejects anything else', () => {
    expect(parseVerifyReference(` cert:${owner}:foundations-v1 `)).toEqual({ ok: true, certId: 'foundations-v1' });
    for (const bad of ['', 'foundations-v1', `cert:${owner}`, `cert:not-an-id:foundations-v1`, `cert:${owner}:Foundations v1`])
      expect(parseVerifyReference(bad)).toEqual({ ok: false });
  });
});

describe('links and rooms', () => {
  it('builds lesson links with encoded slugs', () => {
    expect(lessonHrefFor('a b')).toBe('/academy/a%20b');
    expect(lessonHrefFor('f-1', 'foundations-v1', 'foundations')).toBe('/academy/f-1?cert=foundations-v1&path=foundations');
  });
  it('counts live and scheduled sessions', () => {
    expect(
      roomSummary([{ status: 'live' }, { status: 'scheduled' }, { status: 'scheduled' }, { status: 'ended' }, { status: 'cancelled' }]),
    ).toEqual({
      live: 1,
      scheduled: 2,
    });
  });
});

describe('moments', () => {
  it('shows a UTC date and time, and the raw text when it is not a date', () => {
    expect(formatMoment('2026-10-11T09:05:00.000Z', 'en')).toMatch(/Oct 11, 2026.*9:05.*UTC$/);
    expect(formatMoment('not a date', 'en')).toBe('not a date');
  });
});

describe('tab addresses (AC-order-01)', () => {
  it('gives each of the five tabs its own address, and the tab segment wins over a lesson', () => {
    expect(academyTabs.map(([name]) => name)).toEqual(['Learning', 'Certificates', 'Rooms', 'Videos', 'Programmes']);
    expect(academyRoute('/academy')).toEqual({ kind: 'tab', tab: 'Learning', hub: true });
    for (const [name, slug] of academyTabs) {
      expect(academyRoute(`/academy/${slug}`)).toEqual({ kind: 'tab', tab: name });
      expect(academyTabHref(name)).toBe(`/academy/${slug}`);
    }
    expect(academyRoute('/academy/progress')).toEqual({ kind: 'progress' });
    expect(academyRoute('/academy/foundations-risk-first')).toEqual({ kind: 'reader', slug: 'foundations-risk-first' });
    expect(academyRoute('/academy/%E0%A4%A')).toEqual({ kind: 'reader', slug: undefined });
    expect(academyRoute('/academy/learning/course/markets')).toEqual({ kind: 'course', slug: 'markets' });
    expect(academyRoute('/academy/learning/course')).toEqual({ kind: 'course', slug: undefined });
    expect(academyRoute('/academy/learning/course/markets/assignment/abc')).toEqual({ kind: 'assignment', slug: 'markets', itemId: 'abc' });
    expect(academyAssignmentHref('a b', 'x')).toBe('/academy/learning/course/a%20b/assignment/x');
    expect(academyCourseHref('a b')).toBe('/academy/learning/course/a%20b');
  });

  it('reserves exactly the segments the service refuses as lesson slugs', () => {
    expect([...academyTabs.map(([, slug]) => slug), 'progress'].sort()).toEqual([...ACADEMY_RESERVED_TAB_SLUGS].sort());
  });

  it('sends an old ?section= link to the tab address and keeps its other parameters', () => {
    expect(academySectionRedirect('/academy', '?section=videos')).toBe('/academy/videos');
    expect(academySectionRedirect('/academy', '?cert=c1&section=certificates')).toBe('/academy/certificates?cert=c1');
    expect(academySectionRedirect('/academy', '?section=progress')).toBe('/academy/progress');
    expect(academySectionRedirect('/academy', '?section=constructor')).toBeUndefined();
    expect(academySectionRedirect('/academy', '?path=markets')).toBeUndefined();
    expect(academySectionRedirect('/academy/videos', '?section=rooms')).toBeUndefined();
  });
});

describe('copy', () => {
  it('carries every message in Spanish and French', () => {
    for (const locale of ['es', 'fr'] as const) expect(academyLmsCopy.coverage(locale).missing).toEqual([]);
  });
});

describe('certificate issue and verify links (AC-certificates-01/02)', () => {
  const row = {
    userId: owner,
    certId: 'foundations-v1',
    title: 'Foundations',
    requiredCount: 2,
    completedCount: 2,
    ratio: '1.0000',
    missingItemSlugs: [],
    complete: true,
    granted: false,
    grantIdempotencyKey: null,
  };
  it('a complete certificate waiting out its delay is issuing; with no wait it is ready to request', () => {
    const issuesAt = new Date('2026-10-24T14:00:00.000Z');
    expect(certificateState({ ...row, issue: { mode: 'delayed', delayMinutes: 60, issuesAt } }, undefined)).toBe('issuing');
    expect(certificateState({ ...row, issue: { mode: 'manual', delayMinutes: null, issuesAt: null } }, undefined)).toBe('ready');
    expect(certificateState(row, undefined)).toBe('ready');
  });
  it('words a wait in its largest whole unit', () => {
    expect(issueWait(1)).toEqual({ unit: 'waitMinutes', n: 1 });
    expect(issueWait(120)).toEqual({ unit: 'waitHours', n: 2 });
    expect(issueWait(2880)).toEqual({ unit: 'waitDays', n: 2 });
    expect(issueWait(90)).toEqual({ unit: 'waitMinutes', n: 90 });
  });
  it('the shared link opens the public check under the certificates tab', () => {
    const code = 'a'.repeat(32);
    expect(academyVerifyHref(code)).toBe(`/academy/certificates/verify/${code}`);
    expect(academyRoute(academyVerifyHref(code))).toEqual({ kind: 'verify', code });
    expect(academyRoute('/academy/certificates/verify')).toEqual({ kind: 'verify', code: undefined });
    expect(academyRoute('/academy/certificates')).toEqual({ kind: 'tab', tab: 'Certificates' });
  });
});
