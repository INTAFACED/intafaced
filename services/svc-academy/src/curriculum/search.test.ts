/**
 * AC-catalogue-01 / AC-articles-02 — catalogue query, enrolled search, related
 * items, reserved slugs and the public catalogue door.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { AcademyService } from '../academy-service.js';
import { AcademyError } from '../errors.js';
import { createAcademyRouter } from '../router.js';
import { getCurriculumItem, listCurriculum } from './catalog.js';
import {
  assertNoReservedSlugs,
  assertSlugNotReserved,
  normaliseQuery,
  queryCatalogue,
  relatedItems,
  RESERVED_TAB_SLUGS,
  searchEnrolled,
} from './search.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AcademyError ? err.code : 'not-academy';
  }
  return undefined;
}

const all = listCurriculum();
const first = all[0]!;

describe('reserved tab slugs (AC-articles-02)', () => {
  it.each(RESERVED_TAB_SLUGS)('%s refuses academy.slug_reserved', (slug) => {
    expect(code(() => assertSlugNotReserved(slug))).toBe('academy.slug_reserved');
  });
  it('the start-up check names the colliding slug', () => {
    expect(() => assertNoReservedSlugs(['ok', 'rooms'])).toThrow(/rooms/);
    expect(code(() => assertNoReservedSlugs(all.map((i) => i.slug)))).toBeUndefined();
  });
});

describe('queryCatalogue (AC-catalogue-01)', () => {
  it('q filters by title case-folded', () => {
    const word = first.title.split(' ')[0]!.toUpperCase();
    const out = queryCatalogue({ q: word });
    expect(out.length).toBeGreaterThan(0);
    expect(
      out.every((i) => i.title.toLowerCase().includes(word.toLowerCase()) || i.summary.toLowerCase().includes(word.toLowerCase())),
    ).toBe(true);
  });
  it('no match is an honest empty list', () => {
    expect(queryCatalogue({ q: 'zzqqxx-no-such-text' })).toEqual([]);
  });
  it('sorts by name both ways; recommended keeps the shipped order', () => {
    const asc = queryCatalogue({ sort: 'name_asc' }).map((i) => i.title);
    expect(asc).toEqual([...asc].sort((a, b) => a.localeCompare(b)));
    const desc = queryCatalogue({ sort: 'name_desc' }).map((i) => i.title);
    expect(desc).toEqual([...asc].reverse());
    expect(queryCatalogue({ sort: 'recommended' })).toEqual(all);
  });
  it('empty or over-long query refuses academy.search_query_invalid', () => {
    expect(code(() => normaliseQuery('  '))).toBe('academy.search_query_invalid');
    expect(code(() => normaliseQuery('x'.repeat(121)))).toBe('academy.search_query_invalid');
  });
});

describe('searchEnrolled (AC-catalogue-01)', () => {
  const lesson = all.find((i) => i.kind !== 'workbook')!;
  const body = getCurriculumItem(lesson.slug)!.body;
  const phrase = body.slice(40, 60).trim();

  it('finds a phrase in lesson text with excerpt and offset, only inside enrolled paths', () => {
    const hits = searchEnrolled([lesson.path], phrase, 50);
    const hit = hits.find((h) => h.slug === lesson.slug);
    expect(hit).toBeDefined();
    expect(hit!.excerpt.toLowerCase()).toContain(phrase.toLowerCase().replace(/\s+/g, ' '));
    const others = (['foundations', 'markets', 'builder', 'sovereign'] as const).filter((p) => p !== lesson.path);
    expect(searchEnrolled(others, phrase, 50).some((h) => h.slug === lesson.slug)).toBe(false);
  });
  it('never returns a workbook (exercise) item', () => {
    const wb = all.find((i) => i.kind === 'workbook');
    if (!wb) return;
    expect(searchEnrolled([wb.path], wb.title, 50).some((h) => h.slug === wb.slug)).toBe(false);
  });
  it('no enrolment → no results; limit caps results', () => {
    expect(searchEnrolled([], phrase, 50)).toEqual([]);
    expect(searchEnrolled(['foundations', 'markets', 'builder', 'sovereign'], 'the', 2).length).toBeLessThanOrEqual(2);
  });
});

describe('relatedItems (AC-articles-02)', () => {
  it('returns same-path items without the item itself', () => {
    const out = relatedItems(first.slug, 50);
    expect(out.every((i) => i.path === first.path && i.slug !== first.slug)).toBe(true);
  });
  it('unknown slug refuses academy.curriculum_not_found', () => {
    expect(code(() => relatedItems('no-such-slug', 5))).toBe('academy.curriculum_not_found');
  });
});

const SECRET = 'academy-catalogue-edge-secret-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

function signed(scopes: string[]) {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as unknown as Principal;
  const raw = encodePrincipal(p);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-cat',
  });
}

const academy = {
  myEnrollments: async () => [{ userId: USER, pathSlug: first.path, enrolledAt: new Date(), leftAt: null }],
} as unknown as AcademyService;

function publicCaller(rate: { max: number; windowSeconds: number } | null, address: string | null) {
  const ctx = { ...edge({ headers: {}, id: 'anon' }), ...(address ? { clientAddress: address } : {}) };
  return createAcademyRouter(academy, {}, undefined, undefined, null, rate).createCaller(ctx);
}

describe('doors', () => {
  it('publicCatalogue refuses while the rate is blank', async () => {
    await expect(publicCaller(null, '1.2.3.4').publicCatalogue({ limit: 5 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
  it('publicCatalogue serves signed-out with a rate, then limits', async () => {
    const c = publicCaller({ max: 1, windowSeconds: 60 }, '1.2.3.4');
    const out = await c.publicCatalogue({ limit: 3 });
    expect(out).toHaveLength(3);
    expect(JSON.stringify(out)).not.toMatch(/progress|completed|enrol/i);
    await expect(c.publicCatalogue({ limit: 3 })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
  it('publicCatalogue refuses with no client address and with a blank page size', async () => {
    await expect(publicCaller({ max: 5, windowSeconds: 60 }, null).publicCatalogue({ limit: 3 })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    await expect(publicCaller({ max: 5, windowSeconds: 60 }, '9.9.9.9').publicCatalogue({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });
  it('search scopes to the caller enrolments and refuses a blank limit or empty query', async () => {
    const c = createAcademyRouter(academy).createCaller(signed(['academy:read']));
    await expect(c.search({ q: 'x' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(c.search({ q: ' ', limit: 5 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const hits = await c.search({ q: first.title, limit: 5 });
    expect(hits.every((h) => h.path === first.path)).toBe(true);
  });
  it('curriculum accepts q and sort; curriculumRelated works', async () => {
    const c = createAcademyRouter(academy).createCaller(signed(['academy:read']));
    expect((await c.curriculum({ sort: 'name_asc', limit: 500 })).map((i) => i.title)).toEqual(
      queryCatalogue({ sort: 'name_asc' })
        .map((i) => i.title)
        .slice(0, 500),
    );
    expect(await c.curriculumRelated({ slug: first.slug, limit: 2 })).toHaveLength(
      Math.min(2, listCurriculum({ path: first.path }).length - 1),
    );
  });
});
