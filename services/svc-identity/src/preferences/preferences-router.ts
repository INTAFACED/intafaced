import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { SUPPORTED_LOCALES } from '@intafaced/i18n/locales';
import { uiViewPreferenceSchema } from '@intafaced/contracts/ui-view-preferences';
import { homeTilesPreferenceSchema } from '@intafaced/contracts/home-tiles-preferences';
import { savedScreensPreferenceSchema, watchlistsPreferenceSchema } from '@intafaced/contracts/watchlists-preferences';
import { addressWatchesPreferenceSchema, tokenWatchlistPreferenceSchema } from '@intafaced/contracts/protocol-watch-preferences';
import { ACCOUNT_DISPLAY_NAMESPACE } from './account-display.js';
import { getPreferences, PreferencesError, setPreferences, type PreferenceSettings, type PreferenceView } from './preferences.js';
import { PREFERENCES_VERSION_CONFLICT, TRADE_VIEWS_NAMESPACE } from './trade-views.js';

const view = z
  .object({
    id: z.string(),
    name: z.string(),
    sort: z.string(),
    filters: z.record(z.string(), z.string()),
    columns: z.array(z.string()),
  })
  .strict();

const accountDisplay = z.object({ locale: z.string().nullable(), displayCurrency: z.string().nullable() }).strict();

const tradeViewsPreference = z
  .object({ namespace: z.literal(TRADE_VIEWS_NAMESPACE), version: z.number().int(), value: z.array(view).nullable() })
  .strict();
const accountDisplayPreference = z
  .object({ namespace: z.literal(ACCOUNT_DISPLAY_NAMESPACE), version: z.number().int(), value: accountDisplay.nullable() })
  .strict();
const preference = z.union([
  tradeViewsPreference,
  accountDisplayPreference,
  uiViewPreferenceSchema,
  homeTilesPreferenceSchema,
  watchlistsPreferenceSchema,
  savedScreensPreferenceSchema,
  tokenWatchlistPreferenceSchema,
  addressWatchesPreferenceSchema,
]);
const stored = z.literal('stored');
const storedPreference = z.union([
  tradeViewsPreference.extend({ outcome: stored }).strict(),
  accountDisplayPreference.extend({ outcome: stored }).strict(),
  uiViewPreferenceSchema.extend({ outcome: stored }).strict(),
  homeTilesPreferenceSchema.extend({ outcome: stored }).strict(),
  watchlistsPreferenceSchema.extend({ outcome: stored }).strict(),
  savedScreensPreferenceSchema.extend({ outcome: stored }).strict(),
  tokenWatchlistPreferenceSchema.extend({ outcome: stored }).strict(),
  addressWatchesPreferenceSchema.extend({ outcome: stored }).strict(),
]);

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

export function createPreferencesRouter(sql: Sql, settings?: PreferenceSettings) {
  return router({
    preferences: router({
      /** What the display page may offer: the shipped languages and the currencies the owner lists (empty = unset, USD only). */
      options: scopedProcedure('identity:read')
        .output(
          z
            .object({
              locales: z.array(z.string()),
              displayCurrencies: z.array(z.string()),
              defaultDisplayCurrency: z.literal('USD'),
            })
            .strict(),
        )
        .query(() => ({
          locales: SUPPORTED_LOCALES.map((entry) => entry.code as string),
          displayCurrencies: [...(settings?.displayCurrencies ?? [])],
          defaultDisplayCurrency: 'USD' as const,
        })),
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
        .output(storedPreference)
        .mutation(async ({ ctx, input }) => {
          try {
            const stored = await setPreferences(sql, ctx, input, settings);
            return { namespace: stored.namespace, version: stored.version, value: stored.value, outcome: 'stored' } as PreferenceView & {
              outcome: 'stored';
            };
          } catch (error) {
            preferenceError(error);
          }
        }),
    }),
  });
}
