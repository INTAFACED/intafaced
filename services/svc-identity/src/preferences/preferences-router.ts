import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { getPreferences, PreferencesError, setPreferences } from './preferences.js';
import { PREFERENCES_VERSION_CONFLICT, TRADE_VIEWS_NAMESPACE } from './trade-views.js';

const view = z
  .object({
    id: z.string(),
    name: z.string(),
    sort: z.string(),
    filters: z.record(z.string()),
    columns: z.array(z.string()),
  })
  .strict();

const preference = z
  .object({
    namespace: z.literal(TRADE_VIEWS_NAMESPACE),
    version: z.number().int(),
    value: z.array(view).nullable(),
  })
  .strict();

function preferenceError(error: unknown): never {
  if (error instanceof PreferencesError) {
    const code =
      error.code === PREFERENCES_VERSION_CONFLICT ? 'CONFLICT' : error.code === 'operator.denied' ? 'FORBIDDEN' : 'PRECONDITION_FAILED';
    throw new TRPCError({
      code,
      message: error.code,
      cause: error.current ? { ...error, current: error.current } : error,
    });
  }
  throw error;
}

export function createPreferencesRouter(sql: Sql) {
  return router({
    preferences: router({
      get: scopedProcedure('identity:read')
        .input(z.object({ namespace: z.string().min(1).max(64) }).strict())
        .output(preference)
        .query(async ({ ctx, input }) => {
          try {
            return await getPreferences(sql, ctx, input.namespace);
          } catch (error) {
            preferenceError(error);
          }
        }),
      set: scopedProcedure('identity:write')
        .input(
          z
            .object({
              namespace: z.string().min(1).max(64),
              value: z.unknown(),
              ifVersion: z.number(),
              clientRequestId: z.string().min(1).max(200),
            })
            .strict(),
        )
        .output(preference.extend({ outcome: z.literal('stored') }).strict())
        .mutation(async ({ ctx, input }) => {
          try {
            const stored = await setPreferences(sql, ctx, input);
            return { namespace: stored.namespace, version: stored.version, value: stored.value, outcome: 'stored' as const };
          } catch (error) {
            preferenceError(error);
          }
        }),
    }),
  });
}
