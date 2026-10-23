/**
 * AC-catalogue-01 — the signed-out catalogue, reader and video list. No learner data, no user id, and an item with a
 * prerequisite asks for sign-in instead of opening.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createEdgeContext, type Context } from '@intafaced/contracts';
import { TRPCError } from '@trpc/server';
import type { AcademyService } from '../academy-service.js';
import { ReleaseAccess } from '../release/access.js';
import { createAcademyRouter } from '../router.js';
import { getCurriculumItem, listCurriculum } from './catalog.js';
import { listPublicCourses, publicCourse, searchPublicCurriculum } from './public-catalogue.js';

const SECRET = 'academy-public-catalogue-edge-secret-32b';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

function anonymous(): Context {
  return edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'anon' });
}

function causeOf(err: unknown): string | undefined {
  return ((err as TRPCError).cause as { code?: string } | undefined)?.code;
}

const first = listCurriculum()[0]!;

describe('searchPublicCurriculum', () => {
  it('keeps only items whose title or summary holds the query, case-folded', () => {
    const word = first.title.split(/\s+/).find((w) => w.length > 3)!;
    const rows = searchPublicCurriculum({ q: word.toUpperCase(), limit: 200 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(`${row.title} ${row.summary}`.toLowerCase()).toContain(word.toLowerCase());
    expect(searchPublicCurriculum({ q: 'zz-no-such-phrase-zz', limit: 200 })).toEqual([]);
  });

  it('sorts by the shipped order, or by title either way, and honours the page size', () => {
    expect(searchPublicCurriculum({ limit: 200 }).map((r) => r.slug)).toEqual(listCurriculum().map((r) => r.slug));
    const asc = searchPublicCurriculum({ sort: 'name_asc', limit: 200 }).map((r) => r.title);
    expect(asc).toEqual([...asc].sort((a, b) => a.localeCompare(b, 'en')));
    expect(searchPublicCurriculum({ sort: 'name_desc', limit: 200 }).map((r) => r.title)).toEqual([...asc].reverse());
    expect(searchPublicCurriculum({ limit: 2 })).toHaveLength(2);
    expect(searchPublicCurriculum({ path: 'markets', limit: 200 }).every((r) => r.path === 'markets')).toBe(true);
  });
});

describe('signed-out doors', () => {
  it('return the catalogue with no learner data, refuse a blank page size, and keep the video storage refusal', async () => {
    const caller = createAcademyRouter({} as AcademyService).createCaller(anonymous());
    const rows = await caller.publicCurriculum({ q: first.title, sort: 'name_asc', limit: 10 });
    expect(rows[0]).toEqual({
      slug: first.slug,
      title: first.title,
      kind: first.kind,
      path: first.path,
      order: first.order,
      summary: first.summary,
      estimatedMinutes: first.estimatedMinutes,
    });
    await expect(caller.publicCurriculum({})).rejects.toSatisfy((e) => causeOf(e) === 'academy.curriculum_list_limit_unset');
    await expect(caller.publicVideos()).rejects.toSatisfy((e) => causeOf(e) === 'academy.video_storage_unconfigured');
  });

  it('read the item through the signed-out release check, with no user id', async () => {
    const readPublicCurriculumItem = vi.fn(async () => {
      throw Object.assign(new Error('x'), { name: 'AcademyError' });
    });
    const academy = { readPublicCurriculumItem } as unknown as AcademyService;
    const caller = createAcademyRouter(academy).createCaller(anonymous());
    await caller.publicCurriculumItem({ slug: first.slug }).catch(() => undefined);
    expect(readPublicCurriculumItem).toHaveBeenCalledWith({ slug: first.slug });
    const related = await createAcademyRouter({} as AcademyService)
      .createCaller(anonymous())
      .publicCurriculumRelated({ slug: ` ${first.slug} `, limit: 3 });
    expect(related.every((row) => row.path === first.path && row.slug !== first.slug)).toBe(true);
  });
});

/** A stand-in for the two release tables: prerequisite rows and window rows for the item. */
function fakeSql(tables: { prerequisites: string[]; window: { from: Date; until: Date } | null }): Sql {
  const sql = ((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('item_prerequisites')) return Promise.resolve(tables.prerequisites.map((p) => ({ prerequisite_slug: p })));
    if (text.includes('item_windows'))
      return Promise.resolve(
        tables.window ? [{ available_from: tables.window.from, available_until: tables.window.until, due_at: null }] : [],
      );
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as Sql;
  return sql;
}

describe('ReleaseAccess.assertMayReadSignedOut', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  it('opens an item with no rule, asks for sign-in on a prerequisite, and applies a published window to everyone', async () => {
    await expect(
      new ReleaseAccess(fakeSql({ prerequisites: [], window: null })).assertMayReadSignedOut({ itemSlug: first.slug, now }),
    ).resolves.toBeUndefined();
    await expect(
      new ReleaseAccess(fakeSql({ prerequisites: ['x'], window: null })).assertMayReadSignedOut({ itemSlug: first.slug, now }),
    ).rejects.toMatchObject({ code: 'academy.sign_in_required' });
    const later = { from: new Date('2026-11-01T00:00:00Z'), until: new Date('2026-12-01T00:00:00Z') };
    await expect(
      new ReleaseAccess(fakeSql({ prerequisites: [], window: later })).assertMayReadSignedOut({ itemSlug: first.slug, now }),
    ).rejects.toMatchObject({ code: 'academy.window_invalid' });
    await expect(
      new ReleaseAccess(fakeSql({ prerequisites: [], window: null })).assertMayReadSignedOut({ itemSlug: 'no-such-item', now }),
    ).rejects.toMatchObject({ code: 'academy.curriculum_not_found' });
  });
});

describe('public course page (AC-catalogue-03)', () => {
  it('lists a card per course with published items, and opens a course with its syllabus, outcomes and no invented text', async () => {
    const caller = createAcademyRouter({
      publicCourse: (slug: string) =>
        publicCourse(
          slug,
          () => null,
          async () => true,
        ),
    } as unknown as AcademyService).createCaller(anonymous());
    const cards = await caller.publicCourses();
    expect(new Set(cards.map((c) => c.slug))).toEqual(new Set(listCurriculum().map((r) => r.path)));
    for (const card of cards) expect(card.items).toBe(listCurriculum({ path: card.slug }).length);

    const course = await caller.publicCourse({ slug: 'foundations' });
    expect(course.syllabus.map((r) => r.slug)).toEqual(listCurriculum({ path: 'foundations' }).map((r) => r.slug));
    expect(course.summary).toBeNull();
    expect(course.instructor).toBeNull();
    expect(course.outcomes.length).toBe(new Set(course.outcomes).size);
    expect(course.outcomes.length).toBeGreaterThan(0);
  });

  it('gives the same not-found for an unknown course and a lesson slug', async () => {
    const caller = createAcademyRouter({
      publicCourse: (slug: string) =>
        publicCourse(
          slug,
          () => null,
          async () => true,
        ),
    } as unknown as AcademyService).createCaller(anonymous());
    await expect(caller.publicCourse({ slug: 'no-such-course' })).rejects.toSatisfy((e) => causeOf(e) === 'academy.course_not_found');
    await expect(caller.publicCourse({ slug: first.slug })).rejects.toSatisfy((e) => causeOf(e) === 'academy.course_not_found');
  });

  it('names the certificate only when the owner published one for the path', async () => {
    expect(
      (
        await publicCourse(
          'foundations',
          (p) => (p === 'foundations' ? 'Foundations' : null),
          async () => true,
        )
      ).certificate,
    ).toBe('Foundations');
    const other = listPublicCourses().find((c) => c.slug !== 'foundations');
    if (other)
      expect(
        (
          await publicCourse(
            other.slug,
            () => null,
            async () => true,
          )
        ).certificate,
      ).toBeNull();
  });

  it('keeps the objectives of a lesson a visitor cannot open out of the outcomes, and the lesson in the syllabus', async () => {
    const gated = listCurriculum({ path: 'foundations' })[1]!;
    const own = new Set(getCurriculumItem(gated.slug)!.objectives);
    const course = await publicCourse(
      'foundations',
      () => null,
      async (slug) => slug !== gated.slug,
    );
    expect(course.syllabus.map((r) => r.slug)).toContain(gated.slug);
    const others = new Set(
      listCurriculum({ path: 'foundations' })
        .filter((r) => r.slug !== gated.slug)
        .flatMap((r) => getCurriculumItem(r.slug)!.objectives),
    );
    for (const objective of own) if (!others.has(objective)) expect(course.outcomes).not.toContain(objective);
  });
});
