import { useSyncExternalStore } from 'react';
import { z } from 'zod';

const schema = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  language: z.enum(['en', 'es', 'fr']).default('en'),
  hideBalances: z.boolean().default(false),
  displayCurrency: z.enum(['USD', 'BTC']).default('USD'),
  phoneChart: z.enum(['top', 'bottom', 'hidden']).default('top'),
  upColor: z.enum(['green', 'red']).default('green'),
  timeZone: z.enum(['UTC', 'UTC+8', 'device']).default('UTC'),
  showOrders: z.boolean().default(true),
  showFills: z.boolean().default(false),
  confirmSend: z.boolean().default(true),
  confirmCancel: z.boolean().default(true),
  favoritesView: z.enum(['list', 'cards']).default('list'),
});
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
function notifyChanges() {
  for (const notify of [...listeners]) notify();
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    let next: Preferences;
    try {
      if (event.storageArea !== localStorage) return;
      // Read the current value: a queued event may describe an older write.
      const saved = localStorage.getItem(key);
      const parsed = schema.safeParse(saved === null ? {} : JSON.parse(saved));
      if (!parsed.success) return;
      next = parsed.data;
    } catch {
      // Retain the last valid display preferences when storage is unreadable.
      return;
    }
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    notifyChanges();
  });
}
export function savePreferences(patch: Partial<Preferences>) {
  snapshot = schema.parse({ ...snapshot, ...patch });
  try {
    localStorage.setItem(key, JSON.stringify(snapshot));
  } catch {
    /* Changes still work for this visit. */
  }
  notifyChanges();
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
  );
}
export function currentPreferences() {
  return snapshot;
}

const deviceAppearanceQuery = '(prefers-color-scheme: light)';
function subscribeDeviceAppearance(notify: () => void) {
  const media = window.matchMedia(deviceAppearanceQuery);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}
function deviceUsesLightAppearance() {
  return typeof window !== 'undefined' && window.matchMedia(deviceAppearanceQuery).matches;
}
export function useResolvedTheme(theme: Preferences['theme']): 'light' | 'dark' {
  const deviceIsLight = useSyncExternalStore(subscribeDeviceAppearance, deviceUsesLightAppearance, () => false);
  return theme === 'system' ? (deviceIsLight ? 'light' : 'dark') : theme;
}
