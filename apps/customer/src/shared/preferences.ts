import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { UI_ACTIVE_PROFILE_PATTERN, UI_DISPLAY_CURRENCIES } from '@intafaced/contracts/ui-view-preferences';
import { canonicalUiLocale } from './locale';

const fields = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  language: z
    .string()
    .default('en')
    .transform((value, context) => {
      const canonical = canonicalUiLocale(value);
      if (canonical) return canonical;
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsupported interface language' });
      return z.NEVER;
    }),
  hideBalances: z.boolean().default(false),
  displayCurrency: z.enum(UI_DISPLAY_CURRENCIES).default('USD'),
  phoneChart: z.enum(['top', 'bottom', 'hidden']).default('top'),
  upColor: z.enum(['green', 'red']).default('green'),
  /** Which clock times are shown in. Until the person picks one (`timeZoneChosen`) it is the browser's own zone. */
  timeZone: z.enum(['UTC', 'UTC+8', 'device']).default('device'),
  timeZoneChosen: z.boolean().default(false),
  dailyStart: z.enum(['nativeUTC', 'utc8', 'zoned']).default('nativeUTC'),
  dailyZone: z
    .string()
    .max(100)
    .default('America/New_York')
    .transform((value, context) => {
      try {
        if (!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value.trim())) throw new Error();
        return new Intl.DateTimeFormat('en', { timeZone: value.trim() }).resolvedOptions().timeZone;
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsupported time zone' });
        return z.NEVER;
      }
    }),
  showOrders: z.boolean().default(true),
  showFills: z.boolean().default(false),
  confirmSend: z.boolean().default(true),
  confirmCancel: z.boolean().default(true),
  /** After an order goes through, the desk clears the Amount field. Off keeps it, so the next order starts from the same size. */
  resetSizeOnSubmit: z.boolean().default(true),
  /** Sizes the person set for the desk's quick-size buttons, in the base asset of the open market. Blank shows no buttons. A bad stored list reads as blank. */
  quickSizes: z
    .array(z.string().regex(/^\d+(\.\d{1,18})?$/))
    .max(6)
    .default([])
    .catch([]),
  favoritesView: z.enum(['list', 'cards']).default('list'),
  /**
   * Simple (Robinhood-like) or Pro (dense desk). Layout only: it never changes data, prices or what an action does.
   * A first visit lands on Simple, for everyone (owner decision 2026-10-26, replacing PLT-0009's Pro); a stored Pro choice
   * stays Pro.
   */
  layoutMode: z.enum(['simple', 'pro']).default('simple'),
  /**
   * Which profile the person is looking at: `personal`, or `business:<id>` for a business they belong to. A view choice only,
   * no service reads it. The session checks it against the person's real memberships (`features/session/profiles.ts`).
   */
  activeProfile: z.string().regex(UI_ACTIVE_PROFILE_PATTERN).catch('personal').default('personal'),
});
/**
 * Older saves wrote the whole snapshot, so a stored `UTC` cannot be told apart from a chosen one.
 * Only a zone the person picked after this change (`timeZoneChosen`) overrides the device's own.
 */
const schema = fields.transform((value) => (value.timeZoneChosen ? value : { ...value, timeZone: 'device' as const }));
export type Preferences = z.infer<typeof schema>;
const key = 'intafaced.customer.view.v1';
let snapshot: Preferences = schema.parse({});
try {
  const saved = localStorage.getItem(key);
  if (saved) {
    const parsed = schema.safeParse(JSON.parse(saved));
    if (parsed.success) snapshot = parsed.data;
  }
} catch {
  /* Device storage is optional. */
}
const listeners = new Set<() => void>();
let dailyEpoch = 0;
let preferenceObservation = 0;
export function currentPreferenceObservation() {
  return preferenceObservation;
}
export function usePreferenceObservation() {
  return useSyncExternalStore((notify) => {
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, currentPreferenceObservation);
}
let observedDaily = `${snapshot.dailyStart}:${snapshot.dailyZone}`;
function observeDaily(value: Preferences) {
  const identity = `${value.dailyStart}:${value.dailyZone}`;
  if (identity !== observedDaily) {
    dailyEpoch++;
    observedDaily = identity;
  }
}
export function currentDailyPreferenceEpoch() {
  return dailyEpoch;
}
export function useDailyPreferenceEpoch() {
  return useSyncExternalStore((notify) => {
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, currentDailyPreferenceEpoch);
}
function notifyChanges() {
  for (const notify of [...listeners]) notify();
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    let next: Preferences;
    try {
      if (event.storageArea !== localStorage) return;
      // Observe each valid departure even when queued A→B→A events have
      // already settled back to A in storage. Never install an old value.
      for (const value of [event.oldValue, event.newValue]) {
        try {
          const described = schema.safeParse(value === null ? {} : JSON.parse(value));
          if (described.success) observeDaily(described.data);
        } catch {
          // A malformed description cannot establish a departure or hide a
          // valid description; only validated current storage is installed.
        }
      }
      // Read the current value: a queued event may describe an older write.
      const saved = localStorage.getItem(key);
      const parsed = schema.safeParse(saved === null ? {} : JSON.parse(saved));
      if (!parsed.success) return;
      next = parsed.data;
    } catch {
      // Retain the last valid display preferences when storage is unreadable.
      return;
    }
    preferenceObservation++;
    observeDaily(next);
    if (JSON.stringify(next) === JSON.stringify(snapshot)) {
      notifyChanges();
      return;
    }
    snapshot = next;
    notifyChanges();
  });
}
export type PreferencePersistence = 'device' | 'visit';
export function savePreferences(patch: Partial<Preferences>): PreferencePersistence {
  snapshot = schema.parse({ ...snapshot, ...patch, ...(patch.timeZone !== undefined ? { timeZoneChosen: true } : {}) });
  observeDaily(snapshot);
  let persistence: PreferencePersistence = 'visit';
  try {
    const raw = JSON.stringify(snapshot);
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) === raw) persistence = 'device';
  } catch {
    /* Changes still work for this visit. */
  }
  notifyChanges();
  return persistence;
}
export function usePreferences() {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => snapshot,
    () => snapshot,
  );
}
export function currentPreferences() {
  return snapshot;
}

/**
 * The theme the app draws. Light is out of scope, so every stored value (`light`, `system`, or an old `light` from an
 * earlier build) still renders dark; the stored value is kept untouched, ready for the day light ships.
 */
export function useResolvedTheme(_theme: Preferences['theme']): 'light' | 'dark' {
  return 'dark';
}
