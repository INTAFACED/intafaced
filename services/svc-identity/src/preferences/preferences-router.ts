import { z } from 'zod';
import {
  IDENTITY_WATCHLISTS_CALLERS,
  identityWatchlistsInputSchema,
  identityWatchlistsSchema,
  parseStoredWatchlists,
  watchlistsAnswer,
} from '@intafaced/contracts/identity-watchlists';
import { router, scopedProcedure, serviceProcedureFor, TRPCError } from '@intafaced/contracts/trpc';
import type { Sql } from 'postgres';
import { SUPPORTED_LOCALES } from '@intafaced/i18n/locales';
import { uiViewPreferenceSchema } from '@intafaced/contracts/ui-view-preferences';
import { homeTilesPreferenceSchema } from '@intafaced/contracts/home-tiles-preferences';
import { tradeInstantPreferenceSchema } from '@intafaced/contracts/trade-instant-preferences';
import {
  savedScreensPreferenceSchema,
  WATCHLISTS_NAMESPACE,
  watchlistsPreferenceSchema,
} from '@intafaced/contracts/watchlists-preferences';
import { addressWatchesPreferenceSchema, tokenWatchlistPreferenceSchema } from '@intafaced/contracts/protocol-watch-preferences';
import { deskLayoutsPreferenceSchema } from '@intafaced/contracts/desk-layouts-preferences';
import { chartTemplatesPreferenceSchema } from '@intafaced/contracts/chart-templates-preferences';
import { getPreferences, PreferencesError, setPreferences, type PreferenceSettings, type PreferenceView } from './preferences.js';
import { PREFERENCES_VERSION_CONFLICT } from './trade-views.js';
import {
  tradeViewsPreference,
  accountDisplayPreference,
  IDENTITY_PREFERENCES_GET,
} from '@intafaced/contracts/identity-preferences-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from '../record-refusal.js';

const stored = z.literal('stored');
const storedPreference = z.union([
  tradeViewsPreference.extend({ outcome: stored }).strict(),
  accountDisplayPreference.extend({ outcome: stored }).strict(),
  uiViewPreferenceSchema.extend({ outcome: stored }).strict(),
  homeTilesPreferenceSchema.extend({ outcome: stored }).strict(),
  tradeInstantPreferenceSchema.extend({ outcome: stored }).strict(),
  watchlistsPreferenceSchema.extend({ outcome: stored }).strict(),
  savedScreensPreferenceSchema.extend({ outcome: stored }).strict(),
  tokenWatchlistPreferenceSchema.extend({ outcome: stored }).strict(),
  addressWatchesPreferenceSchema.extend({ outcome: stored }).strict(),
  deskLayoutsPreferenceSchema.extend({ outcome: stored }).strict(),
  chartTemplatesPreferenceSchema.extend({ outcome: stored }).strict(),
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
      get: mountRecord(
        IDENTITY_PREFERENCES_GET,
        async ({ ctx, input }) => {
          try {
            return await getPreferences(sql, ctx, input.namespace);
          } catch (error) {
            preferenceError(error);
          }
        },
        codedRefusal,
      ),
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
      /**
       * A person's watchlists for svc-notify's watchlist alerts (J-charts-desk-09 #7): each list's id, name and symbols. Service
       * only: `serviceProcedureFor` proves the caller is svc-notify before the input is parsed. A read of the view record and
       * nothing else; a POST only because the caller signs the body. A stored record that is not the shape refuses, so the
       * caller says it has no answer instead of reading the lists as empty.
       */
      watchlistsFor: serviceProcedureFor(IDENTITY_WATCHLISTS_CALLERS)
        .input(identityWatchlistsInputSchema)
        .output(identityWatchlistsSchema)
        .mutation(async ({ input }) => {
          const [row] = await sql<Array<{ value: unknown }>>`
            SELECT value FROM user_preferences WHERE user_id = ${input.userId} AND namespace = ${WATCHLISTS_NAMESPACE}
          `;
          try {
            return watchlistsAnswer(parseStoredWatchlists(row?.value ?? null));
          } catch {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'identity.watchlists_record_invalid' });
          }
        }),
    }),
  });
}
