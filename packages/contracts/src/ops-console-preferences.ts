import { z } from 'zod';

/**
 * Wire types for founder console preferences (OPS-admin-access-08, ops-console-admin-access-038).
 *
 * A preference can be set at four levels: the server's shipped defaults, the organisation, the person's team, and the
 * person. For each preference the most specific level that sets it wins. A level that leaves a preference unset (null)
 * passes it down from the level above. The server level is fixed in code and always sets every preference, so each one
 * always has a value and a level it came from.
 *
 * Teams: the staff directory names no team for a founder yet, so the team level is shown with that blocker and cannot be
 * set (`ops.preferences_team_unassigned`). Themes: the console has one look (dark); another is the owner's call, so `dark`
 * is the only theme.
 *
 * Browser-safe: zod only.
 */

export const PREFERENCE_LEVELS = ['server', 'organisation', 'team', 'person'] as const;
export type PreferenceLevel = (typeof PREFERENCE_LEVELS)[number];
/** The levels a founder can write: the organisation for everyone, and themself. */
export const WRITABLE_PREFERENCE_LEVELS = ['organisation', 'person'] as const;
export type WritablePreferenceLevel = (typeof WRITABLE_PREFERENCE_LEVELS)[number];

export const PREFERENCE_KEYS = ['theme', 'homePage', 'timeZone', 'weekStart'] as const;
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export const CONSOLE_THEMES = ['dark'] as const;
export const WEEK_STARTS = ['monday', 'saturday', 'sunday'] as const;

export const PREFERENCE_INVALID = 'ops.preference_invalid' as const;
export const PREFERENCES_TEAM_UNASSIGNED = 'ops.preferences_team_unassigned' as const;
export const PREFERENCES_STORAGE_UNCONFIGURED = 'ops.preferences_storage_unconfigured' as const;
/** The level changed since the founder read it: read it again, so another founder's change is never overwritten unseen. */
export const PREFERENCES_STALE = 'ops.preferences_stale' as const;

/** A console page: a path from the root, letters, digits, dashes and slashes only. */
export const CONSOLE_HOME_PAGE = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/;

/** An IANA time zone the runtime knows, such as `Europe/Berlin` or `UTC`. */
export function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const preferenceValuesSchema = z.object({
  theme: z.enum(CONSOLE_THEMES).nullable(),
  homePage: z.string().regex(CONSOLE_HOME_PAGE).max(200).nullable(),
  timeZone: z.string().refine(isTimeZone, 'not a time zone').nullable(),
  weekStart: z.enum(WEEK_STARTS).nullable(),
});
/** One level's values: null leaves that preference to the level above. */
export type PreferenceValues = z.infer<typeof preferenceValuesSchema>;
export type ResolvedPreferences = { readonly [K in PreferenceKey]: NonNullable<PreferenceValues[K]> };

/** The server level: shipped with the console, the same as before preferences existed (dark, the CRM desk, UTC). */
export const SERVER_PREFERENCES: ResolvedPreferences = { theme: 'dark', homePage: '/crm', timeZone: 'UTC', weekStart: 'monday' };

export const UNSET_PREFERENCES: PreferenceValues = { theme: null, homePage: null, timeZone: null, weekStart: null };

const iso = z.string().datetime({ offset: true });

const storedLevelSchema = z.object({
  values: preferenceValuesSchema,
  /** 0 when nothing was ever set at this level; each save adds one. A save names the revision it read. */
  revision: z.number().int().nonnegative(),
  /** null when nothing was ever set at this level. */
  updatedAt: iso.nullable(),
  updatedBy: z.string().nullable(),
});

export const preferencesSchema = z.object({
  /** The founder these preferences resolve for: the caller. */
  personId: z.string(),
  levels: z.object({
    server: z.object({ values: preferenceValuesSchema }),
    organisation: storedLevelSchema,
    team: z.object({ values: preferenceValuesSchema, blocker: z.literal(PREFERENCES_TEAM_UNASSIGNED) }),
    person: storedLevelSchema,
  }),
  effective: z.object({
    theme: z.object({ value: z.enum(CONSOLE_THEMES), from: z.enum(PREFERENCE_LEVELS) }),
    homePage: z.object({ value: z.string(), from: z.enum(PREFERENCE_LEVELS) }),
    timeZone: z.object({ value: z.string(), from: z.enum(PREFERENCE_LEVELS) }),
    weekStart: z.object({ value: z.enum(WEEK_STARTS), from: z.enum(PREFERENCE_LEVELS) }),
  }),
  asOf: iso,
});
export type Preferences = z.infer<typeof preferencesSchema>;
export type EffectivePreferences = Preferences['effective'];

/** For each preference, the most specific level that sets it. */
export function resolvePreferences(levels: { readonly [L in PreferenceLevel]?: PreferenceValues | null }): EffectivePreferences {
  const order = [...PREFERENCE_LEVELS].reverse();
  const pick = <K extends PreferenceKey>(key: K) => {
    for (const level of order) {
      const value = level === 'server' ? SERVER_PREFERENCES[key] : levels[level]?.[key];
      if (value !== null && value !== undefined) return { value: value as ResolvedPreferences[K], from: level };
    }
    return { value: SERVER_PREFERENCES[key], from: 'server' as const };
  };
  return { theme: pick('theme'), homePage: pick('homePage'), timeZone: pick('timeZone'), weekStart: pick('weekStart') };
}

/**
 * Set one level, from the revision the founder read (`expectedRevision`; a different one refuses `ops.preferences_stale`):
 * every key is sent, null clears it at that level. The wire takes any short string per key, and the team level, so svc-ops
 * can name what it refuses (`ops.preference_invalid`, `ops.preferences_team_unassigned`); `preferenceValuesSchema` is the check.
 */
const loose = z.string().max(200).nullable();
export const preferencesSetInputSchema = z.object({
  level: z.enum(['organisation', 'team', 'person']),
  expectedRevision: z.number().int().nonnegative(),
  values: z.object({ theme: loose, homePage: loose, timeZone: loose, weekStart: loose }),
});
export type PreferencesSetInput = z.infer<typeof preferencesSetInputSchema>;

/** The keys whose values are not ones the console takes, or an empty list. */
export function invalidPreferenceKeys(values: PreferencesSetInput['values']): PreferenceKey[] {
  const parsed = preferenceValuesSchema.safeParse(values);
  if (parsed.success) return [];
  return [
    ...new Set(parsed.error.issues.map((i) => i.path[0]).filter((k): k is PreferenceKey => PREFERENCE_KEYS.includes(k as PreferenceKey))),
  ];
}
