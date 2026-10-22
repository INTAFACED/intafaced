/**
 * AC-articles-02 — reserved tab slugs, the start-up check and related items.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { AcademyService } from '../academy-service.js';
import { AcademyError } from '../errors.js';
import { createAcademyRouter } from '../router.js';
import { listCurriculum } from './catalog.js';
import { relatedItems } from './related.js';
import { assertNoReservedSlugs, assertSlugNotReserved, RESERVED_TAB_SLUGS } from './reserved-slugs.js';

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
    expect(code(() => assertNoReservedSlugs(['ok', 'rooms']))).toBe('academy.slug_reserved');
  });
  it('the shipped curriculum has no reserved slug (the module loaded)', () => {
    expect(all.some((i) => RESERVED_TAB_SLUGS.includes(i.slug))).toBe(false);
  });
});

describe('relatedItems (AC-articles-02)', () => {
  it('returns same-path items without the item itself', () => {
    const out = relatedItems(first.slug, 50);
    expect(out.length).toBe(listCurriculum({ path: first.path }).length - 1);
    expect(out.every((i) => i.path === first.path && i.slug !== first.slug)).toBe(true);
  });
  it('limit caps the list', () => {
    expect(relatedItems(first.slug, 1).length).toBeLessThanOrEqual(1);
  });
  it('unknown slug refuses academy.curriculum_not_found', () => {
    expect(code(() => relatedItems('no-such-slug', 5))).toBe('academy.curriculum_not_found');
  });
});

const SECRET = 'academy-related-edge-secret-32-chars-x';
const USER = '11111111-1111-4111-8111-111111111111';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

function caller() {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['academy:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as unknown as Principal;
  const raw = encodePrincipal(p);
  return createAcademyRouter({} as AcademyService).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-related',
    }),
  );
}

async function causeCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { cause?: { code?: string } }).cause?.code;
  }
  return undefined;
}

describe('curriculumRelated door', () => {
  it('returns related items', async () => {
    expect(await caller().curriculumRelated({ slug: first.slug, limit: 2 })).toEqual(relatedItems(first.slug, 2));
  });
  it('refuses a blank page size with academy.curriculum_list_limit_unset', async () => {
    expect(await causeCode(caller().curriculumRelated({ slug: first.slug }))).toBe('academy.curriculum_list_limit_unset');
  });
  it('refuses an unknown slug with academy.curriculum_not_found', async () => {
    expect(await causeCode(caller().curriculumRelated({ slug: 'no-such-slug', limit: 2 }))).toBe('academy.curriculum_not_found');
  });
});
