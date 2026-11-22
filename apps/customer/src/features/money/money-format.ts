import { t as copyText } from './copy';
import { currentPreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';
import { displayAmount } from '../../shared/money';

/** An amount and its asset in the app's one look, or the words for none. */
export const amount = (value: string | null | undefined, asset: string) =>
  value == null ? copyText('components.unavailable') : `${displayAmount(value)} ${asset}`;
/** One date and time look across the app: "18 Oct, 01:05" in the viewer's zone, with a picked zone named. */
export function date(value: string | null, seconds = false) {
  if (!value) return copyText('components.none');
  if (!Number.isFinite(Date.parse(value))) return copyText('components.date.unavailable');
  return stamp(value, currentPreferences().timeZone, Date.now(), seconds);
}
