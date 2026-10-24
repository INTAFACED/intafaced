import { TRPCError } from '@trpc/server';
import {
  PREFERENCE_INVALID,
  PREFERENCES_STALE,
  PREFERENCES_STORAGE_UNCONFIGURED,
  PREFERENCES_TEAM_UNASSIGNED,
  SERVER_PREFERENCES,
  UNSET_PREFERENCES,
  invalidPreferenceKeys,
  preferenceValuesSchema,
  preferencesSchema,
  preferencesSetInputSchema,
  resolvePreferences,
  router,
  scopedProcedure,
  type Preferences,
} from '@intafaced/contracts';
import { OpsError } from '../codes.js';
import type { LevelRef, PreferenceStore, StoredLevel } from './store.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

export interface PreferencesDeps {
  readonly store: PreferenceStore | undefined;
  readonly now: () => string;
}

const organisation: LevelRef = { level: 'organisation', subject: '' };
const person = (userId: string): LevelRef => ({ level: 'person', subject: userId });

function storeOf(deps: PreferencesDeps): PreferenceStore {
  if (!deps.store)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `${PREFERENCES_STORAGE_UNCONFIGURED} — no durable storage is configured for console preferences, so every one reads as the server's and none can be set`,
      cause: new OpsError(PREFERENCES_STORAGE_UNCONFIGURED, 'no storage'),
    });
  return deps.store;
}

const refusal = (code: 'BAD_REQUEST' | 'CONFLICT', err: OpsError) =>
  new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });

/** The four levels for one founder, and for each preference the most specific level that sets it. */
function view(userId: string, org: StoredLevel, mine: StoredLevel, asOf: string): Preferences {
  return {
    personId: userId,
    levels: {
      server: { values: { ...SERVER_PREFERENCES } },
      organisation: org,
      // The staff directory names no team for a founder, so this level holds nothing and cannot be set.
      team: { values: UNSET_PREFERENCES, blocker: PREFERENCES_TEAM_UNASSIGNED },
      person: mine,
    },
    effective: resolvePreferences({ organisation: org.values, person: mine.values }),
    asOf,
  };
}

/**
 * `preferences.get` (`admin:read`): the caller's console preferences at every level, and the ones in force.
 * `preferences.set` (`admin:write`): replace the organisation's values, or the caller's own (never another founder's), from
 * the revision the caller read. The team level refuses `ops.preferences_team_unassigned`; a value the console does not take
 * refuses `ops.preference_invalid`; a level saved since it was read refuses `ops.preferences_stale`.
 * No money moves; preferences change how the console looks and opens, never what it may do.
 */
export function createPreferencesRouter(deps: PreferencesDeps) {
  return router({
    get: scopedProcedure('admin:read', guards)
      .output(preferencesSchema)
      .query(async ({ ctx }) => {
        const store = storeOf(deps);
        const [org, mine] = await Promise.all([store.get(organisation), store.get(person(ctx.principal.userId))]);
        return view(ctx.principal.userId, org, mine, deps.now());
      }),
    set: scopedProcedure('admin:write', guards)
      .input(preferencesSetInputSchema)
      .output(preferencesSchema)
      .mutation(async ({ ctx, input }) => {
        if (input.level === 'team')
          throw refusal(
            'BAD_REQUEST',
            new OpsError(PREFERENCES_TEAM_UNASSIGNED, 'the staff directory names no team for a founder, so team preferences cannot be set'),
          );
        const bad = invalidPreferenceKeys(input.values);
        if (bad.length > 0)
          throw refusal('BAD_REQUEST', new OpsError(PREFERENCE_INVALID, `not a value the console takes: ${bad.join(', ')}`));
        const values = preferenceValuesSchema.parse(input.values);
        const store = storeOf(deps);
        const at = deps.now();
        const userId = ctx.principal.userId;
        const ref = input.level === 'organisation' ? organisation : person(userId);
        let saved: StoredLevel;
        try {
          saved = await store.set(ref, input.expectedRevision, values, userId, at);
        } catch (err) {
          if (err instanceof OpsError && err.code === PREFERENCES_STALE) throw refusal('CONFLICT', err);
          throw err;
        }
        const other = await store.get(input.level === 'organisation' ? person(userId) : organisation);
        return input.level === 'organisation' ? view(userId, saved, other, at) : view(userId, other, saved, at);
      }),
  });
}
