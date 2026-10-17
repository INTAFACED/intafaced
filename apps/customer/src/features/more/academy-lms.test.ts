import { describe, expect, it } from 'vitest';
import {
  buildTracking,
  certificateCards,
  certificateDocument,
  certificateLessons,
  certificateState,
  emptyTracking,
  groupByPath,
  lessonHrefFor,
  lessonStatus,
  neighbours,
  nextUp,
  parseVerifyReference,
  pathProgress,
  readLastLesson,
  rememberLastLesson,
  resumeTarget,
  roomSummary,
  tabForSection,
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

describe('tracking and lesson status', () => {
  it('knows recorded and pending only for certificate-required lessons', () => {
    const tracking = buildTracking([definition], [progress(['f-2'])], []);
    expect(lessonStatus('f-1', tracking)).toBe('recorded');
    expect(lessonStatus('f-2', tracking)).toBe('pending');
    expect(lessonStatus('f-3', tracking)).toBe('untracked');
    expect(lessonStatus('anything', emptyTracking)).toBe('untracked');
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
    expect(lessonStatus('f-1', tracking)).toBe('untracked');
  });
});

describe('paths and progress', () => {
  it('groups by path in the service order and sums minutes', () => {
    const groups = groupByPath(lessons);
    expect(groups.map((g) => g.path)).toEqual(['foundations', 'markets', 'sovereign']);
    expect(groups[0]!.lessons.map((l) => l.slug)).toEqual(['f-1', 'f-2', 'f-3']);
    expect(groups[0]).toMatchObject({ minutes: 40, playbooks: 1, workbooks: 1, readings: 1 });
  });

  it('draws no percentage when nothing is tracked', () => {
    const marketsOnly = lessons.filter((l) => l.path === 'markets');
    const tracking = buildTracking([definition], [progress(['f-2'])], []);
    expect(pathProgress(marketsOnly, tracking)).toMatchObject({ total: 1, tracked: 0, untracked: 1, percent: null });
  });

  it('computes progress over tracked lessons only and floors the percentage', () => {
    const tracking = buildTracking([definition], [progress(['f-2'])], []);
    const result = pathProgress(groupByPath(lessons)[0]!.lessons, tracking);
    expect(result).toEqual({ total: 3, tracked: 2, recorded: 1, pending: 1, untracked: 1, percent: 50 });
    const third = buildTracking(
      [{ ...definition, requiredItemSlugs: ['f-1', 'f-2', 'f-3'] }],
      [progress(['f-2', 'f-3'], { requiredCount: 3, completedCount: 1 })],
      [],
    );
    expect(pathProgress(groupByPath(lessons)[0]!.lessons, third).percent).toBe(33);
  });

  it('finds previous and next within a path and tolerates an unknown slug', () => {
    const inPath = groupByPath(lessons)[0]!.lessons;
    expect(neighbours(inPath, 'f-2')).toMatchObject({ previous: { slug: 'f-1' }, next: { slug: 'f-3' }, position: 2, total: 3 });
    expect(neighbours(inPath, 'f-1').previous).toBeNull();
    expect(neighbours(inPath, 'f-3').next).toBeNull();
    expect(neighbours(inPath, 'nope')).toEqual({ previous: null, next: null, position: 0, total: 3 });
  });

  it('offers the first pending lesson, then the first untracked one, then nothing', () => {
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
      requirements: 2,
    });
    const ready = certificateCards(buildTracking([definition], [progress([])], []))[0]!;
    expect(certificateDocument(ready, owner)).toBeNull();
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

describe('section links', () => {
  it('opens the matching tab and falls back to Learning', () => {
    expect(tabForSection('certificates')).toBe('Certificates');
    expect(tabForSection('videos')).toBe('Videos');
    expect(tabForSection('programmes')).toBe('Programmes');
    expect(tabForSection('rooms')).toBe('Rooms');
    expect(tabForSection(null)).toBe('Learning');
    expect(tabForSection('constructor')).toBe('Learning');
  });
});

describe('copy', () => {
  it('carries every message in Spanish and French', () => {
    for (const locale of ['es', 'fr'] as const) expect(academyLmsCopy.coverage(locale).missing).toEqual([]);
  });
});
