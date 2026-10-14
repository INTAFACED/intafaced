import { usePreferences } from '../../../shared/preferences';

/** Sample dates are fixed instants (UTC) in the fixture; they are drawn in the viewer's own zone (device zone until the person picks one). */
export function useSampleDate(): (iso: string) => string {
  const preferences = usePreferences();
  return (iso) =>
    new Intl.DateTimeFormat(preferences.language, {
      month: 'short',
      year: 'numeric',
      ...(preferences.timeZone === 'device' ? {} : { timeZone: preferences.timeZone === 'UTC+8' ? 'Asia/Singapore' : 'UTC' }),
    }).format(new Date(iso));
}
