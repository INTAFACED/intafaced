/**
 * AC-catalogue-01 doors. The learning screen calls `curriculum`; these sit beside it.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, mergeRouters, signPrincipalHeader } from '@intafaced/contracts';
import type { AcademyService } from '../academy-service.js';
import { createAcademyRouter } from '../router.js';
import { spineCatalogueItems } from './items.js';
import { createCatalogueRouter, type CatalogueDeps } from './router.js';

const SECRET = 'academy-catalogue-edge-secret-32x';
const USER = '11111111-1111-4111-8111-111111111111';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

function signed() {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['academy:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-catalogue',
  });
}

function anonymous(address?: string) {
  const ctx = edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'anon-catalogue' });
  return Object.assign(ctx, { clientAddress: address ?? '' });
}

async function cause(p: Promise<unknown>): Promise<{ code?: string; cause?: string }> {
  try {
    await p;
    return {};
  } catch (err) {
    const error = err as { code?: string; cause?: { code?: string } };
    return { code: error.code, cause: error.cause?.code };
  }
}

function deps(overrides: Partial<CatalogueDeps> = {}): CatalogueDeps {
  return {
    owner: { searchListLimit: 10, publicReadRate: { max: 2, windowSeconds: 60 } },
    enrolledPaths: async () => ['foundations'],
    completedSlugs: async () => [],
    ...overrides,
  };
}

describe('catalogue doors (AC-catalogue-01)', () => {
  it('mounts beside curriculum without replacing it', () => {
    const merged = mergeRouters(createAcademyRouter({} as AcademyService), createCatalogueRouter(deps()));
    const keys = Object.keys(merged._def.procedures);
    expect(keys).toEqual(expect.arrayContaining(['curriculum', 'publicCatalogue', 'catalogue', 'search']));
  });

  it('a blank public rate and a blank address refuse before any card', async () => {
    const unset = createCatalogueRouter(deps({ owner: { searchListLimit: 10, publicReadRate: null } }));
    expect(await cause(unset.createCaller(anonymous('203.0.113.10')).publicCatalogue({ limit: 5 }))).toEqual({
      code: 'PRECONDITION_FAILED',
      cause: 'academy.public_read_rate_unset',
    });
    const open = createCatalogueRouter(deps());
    expect(await cause(open.createCaller(anonymous()).publicCatalogue({ limit: 5 }))).toEqual({
      code: 'PRECONDITION_FAILED',
      cause: 'academy.public_read_address_unset',
    });
  });

  it('the signed-out catalogue has no learner data, and the third read in the window is limited', async () => {
    const caller = createCatalogueRouter(deps()).createCaller(anonymous('203.0.113.10'));
    const first = await caller.publicCatalogue({ limit: 5, q: 'risk' });
    expect(first.length).toBeGreaterThan(0);
    expect(JSON.stringify(first)).not.toMatch(/userId|progress|author/i);
    expect(first.every((card) => card.title.toLowerCase().includes('risk') || card.summary.toLowerCase().includes('risk'))).toBe(true);
    await caller.publicCatalogue({ limit: 5 });
    expect(await cause(caller.publicCatalogue({ limit: 5 }))).toEqual({
      code: 'TOO_MANY_REQUESTS',
      cause: 'academy.public_read_rate_limited',
    });
  });

  it('each address has its own public rate', async () => {
    const door = createCatalogueRouter(deps({ owner: { searchListLimit: 10, publicReadRate: { max: 1, windowSeconds: 60 } } }));
    await door.createCaller(anonymous('203.0.113.10')).publicCatalogue({ limit: 1 });
    expect(await cause(door.createCaller(anonymous('203.0.113.10')).publicCatalogue({ limit: 1 }))).toEqual({
      code: 'TOO_MANY_REQUESTS',
      cause: 'academy.public_read_rate_limited',
    });
    expect(await door.createCaller(anonymous('203.0.113.11')).publicCatalogue({ limit: 1 })).toHaveLength(1);
  });

  it('a blank page size refuses, and a signed-in browse does not need the public rate', async () => {
    const caller = createCatalogueRouter(deps({ owner: { searchListLimit: null, publicReadRate: null } })).createCaller(signed());
    expect(await cause(caller.catalogue())).toEqual({ code: 'PRECONDITION_FAILED', cause: 'academy.curriculum_list_limit_unset' });
    const cards = await caller.catalogue({ limit: 5, sort: 'name_asc' });
    expect(cards.length).toBeGreaterThan(0);
    const ordered = [...cards].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.slug.localeCompare(b.slug));
    expect(cards.map((card) => card.slug)).toEqual(ordered.map((card) => card.slug));
  });

  it('search refuses a blank owner limit and an empty query, and stays inside the enrolment', async () => {
    const blank = createCatalogueRouter(deps({ owner: { searchListLimit: null, publicReadRate: null } })).createCaller(signed());
    expect(await cause(blank.search({ q: 'risk' }))).toEqual({ code: 'PRECONDITION_FAILED', cause: 'academy.search_list_limit_unset' });
    const caller = createCatalogueRouter(deps()).createCaller(signed());
    expect(await cause(caller.search({ q: '   ' }))).toEqual({ code: 'BAD_REQUEST', cause: 'academy.search_query_invalid' });
    const hits = await caller.search({ q: 'invalidation level' });
    expect(hits.length).toBeGreaterThan(0);
    const paths = new Map(spineCatalogueItems().map((item) => [item.slug, item.path]));
    expect(hits.every((hit) => paths.get(hit.slug) === 'foundations')).toBe(true);
    expect(hits.every((hit) => hit.offset === null || hit.excerpt.toLowerCase().includes('invalidation level'))).toBe(true);
    const again = await caller.search({ q: 'invalidation level' });
    expect(again).toEqual(hits);
  });

  it('a learner with no enrolment gets no hits', async () => {
    const caller = createCatalogueRouter(deps({ enrolledPaths: async () => [] })).createCaller(signed());
    expect(await caller.search({ q: 'invalidation level' })).toEqual([]);
  });
});
