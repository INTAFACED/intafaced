/**
 * AC-catalogue-01 doors.
 *
 * Mounted beside `createAcademyRouter` (see index.ts). `router.ts` is already
 * edited by the open AC-videos-01 pull request, so `curriculum` itself is
 * unchanged. The learning screen still calls `curriculum`. `catalogue` is the
 * same card list plus query, category and sort. `publicCatalogue` is the
 * signed-out read and carries no learner data. `search` is in-course text.
 */
import { z } from 'zod';
import { publicProcedure, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { assertCurriculumPageLimit } from '../curriculum/catalog.js';
import { VerifyRateLimiter } from '../certs/verify-rate.js';
import { browseCatalogue, type CatalogueSort } from './browse.js';
import { CatalogueError } from './errors.js';
import { spineCatalogueItems, type CatalogueItem } from './items.js';
import { assertSearchQuery, requireSearchListLimit, type CatalogueOwner } from './owner.js';
import { searchEnrolled } from './search.js';

const cardOut = z.object({
  slug: z.string(),
  title: z.string(),
  kind: z.enum(['playbook', 'workbook', 'lesson']),
  path: z.enum(['foundations', 'markets', 'builder', 'sovereign']),
  order: z.number().int(),
  summary: z.string(),
  estimatedMinutes: z.number().int().positive(),
});

const hitOut = z.object({
  slug: z.string(),
  title: z.string(),
  excerpt: z.string(),
  offset: z.number().int().nonnegative().nullable(),
});

const signedSort = z.enum(['progress', 'name_asc', 'name_desc', 'recommended']);
const publicSort = z.enum(['name_asc', 'name_desc', 'recommended']);

function clientAddressOf(ctx: object): string | null {
  const value = (ctx as { clientAddress?: unknown }).clientAddress;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toCatalogueTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof CatalogueError) {
    const code =
      err.code === 'academy.search_query_invalid'
        ? 'BAD_REQUEST'
        : err.code === 'academy.public_read_rate_limited'
          ? 'TOO_MANY_REQUESTS'
          : 'PRECONDITION_FAILED';
    return new TRPCError({ code, message: err.code, cause: err });
  }
  if (err instanceof AcademyError && err.code === 'academy.curriculum_list_limit_unset') {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.code, cause: err });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: err });
}

export type CatalogueDeps = {
  readonly owner: CatalogueOwner;
  readonly items?: readonly CatalogueItem[];
  readonly enrolledPaths: (userId: string) => Promise<readonly string[]>;
  readonly completedSlugs: (userId: string) => Promise<readonly string[]>;
  readonly limiter?: VerifyRateLimiter;
};

export function createCatalogueRouter(deps: CatalogueDeps) {
  const items = deps.items ?? spineCatalogueItems();
  const limiter = deps.limiter ?? new VerifyRateLimiter();
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toCatalogueTrpcError(err);
    }
  };

  const browse = (
    input: { q?: string; category?: string; kind?: string; sort?: CatalogueSort; limit?: number },
    completed: readonly string[],
  ) => {
    const query = input.q === undefined ? undefined : assertSearchQuery(input.q);
    const limit = assertCurriculumPageLimit(input.limit);
    return browseCatalogue({
      items,
      sort: input.sort ?? 'recommended',
      limit,
      ...(query === undefined ? {} : { query }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.sort === 'progress' ? { completedSlugs: completed } : {}),
    });
  };

  return router({
    /**
     * Signed-out catalogue. No progress and no enrolment. A blank rate or a
     * blank caller address refuses before any card is built.
     */
    publicCatalogue: publicProcedure
      .input(
        z
          .object({
            q: z.string().optional(),
            category: z.string().optional(),
            kind: z.enum(['playbook', 'workbook', 'lesson']).optional(),
            sort: publicSort.optional(),
            limit: z.number().optional(),
          })
          .optional(),
      )
      .output(z.array(cardOut))
      .query(({ input, ctx }) =>
        guard(async () => {
          const rate = deps.owner.publicReadRate;
          if (!rate) throw new CatalogueError('academy.public_read_rate_unset', 'academy.public_read_rate_unset');
          const address = clientAddressOf(ctx);
          if (!address) throw new CatalogueError('academy.public_read_address_unset', 'academy.public_read_address_unset');
          if (input?.q !== undefined) assertSearchQuery(input.q);
          assertCurriculumPageLimit(input?.limit);
          if (limiter.take(address, rate) === 'limited') {
            throw new CatalogueError('academy.public_read_rate_limited', 'academy.public_read_rate_limited');
          }
          return browse(
            {
              ...(input?.q === undefined ? {} : { q: input.q }),
              ...(input?.category === undefined ? {} : { category: input.category }),
              ...(input?.kind === undefined ? {} : { kind: input.kind }),
              ...(input?.sort === undefined ? {} : { sort: input.sort }),
              ...(input?.limit === undefined ? {} : { limit: input.limit }),
            },
            [],
          );
        }),
      ),

    /** Signed-in catalogue. Progress sort uses this account's completions only. */
    catalogue: scopedProcedure('academy:read', { module: 'academy' })
      .input(
        z
          .object({
            q: z.string().optional(),
            category: z.string().optional(),
            kind: z.enum(['playbook', 'workbook', 'lesson']).optional(),
            sort: signedSort.optional(),
            limit: z.number().optional(),
          })
          .optional(),
      )
      .output(z.array(cardOut))
      .query(({ input, ctx }) =>
        guard(async () => {
          const completed = input?.sort === 'progress' ? await deps.completedSlugs(ctx.principal.userId) : [];
          return browse(
            {
              ...(input?.q === undefined ? {} : { q: input.q }),
              ...(input?.category === undefined ? {} : { category: input.category }),
              ...(input?.kind === undefined ? {} : { kind: input.kind }),
              ...(input?.sort === undefined ? {} : { sort: input.sort }),
              ...(input?.limit === undefined ? {} : { limit: input.limit }),
            },
            completed,
          );
        }),
      ),

    /** Lesson text inside the caller's own enrolments. The caller cannot set the page size. */
    search: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ q: z.string().optional() }).optional())
      .output(z.array(hitOut))
      .query(({ input, ctx }) =>
        guard(async () => {
          const limit = requireSearchListLimit(deps.owner);
          const query = assertSearchQuery(input?.q);
          const enrolledPaths = await deps.enrolledPaths(ctx.principal.userId);
          return searchEnrolled({ items, query, enrolledPaths, limit });
        }),
      ),
  });
}
