import { usePreferences } from '../../../shared/preferences';

/**
 * Sample times are fixed instants (UTC) in the fixture; they are drawn in the viewer's own zone, the same rule as every other screen
 * (Preferences: device zone until the person picks one).
 */
export function useSampleTime(): (iso: string) => string {
  const preferences = usePreferences();
  return (iso) =>
    new Intl.DateTimeFormat(preferences.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(preferences.timeZone === 'device' ? {} : { timeZone: preferences.timeZone === 'UTC+8' ? 'Asia/Singapore' : 'UTC' }),
    }).format(new Date(iso));
}
