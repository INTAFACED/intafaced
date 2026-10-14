// Drawing helpers shared by the three derivatives Preview screens (futures, options, margin). Strings and scaled bigints in, text out.
import { fractionDigits, str, type Scaled } from '../../../data/decimal';
import { fmtAmount, fmtPct, fmtPrice, fmtUsd, fmtUsdChange } from '../../../data/format';

/** "$1,579.50". */
export const usd = (value: Scaled | string, options: { compact?: boolean } = {}): string =>
  fmtUsd(typeof value === 'string' ? value : str(value), options);

/** "+$267.50" / "−$171.20". */
export const signedUsd = (value: Scaled | string): string => fmtUsdChange(typeof value === 'string' ? value : str(value));

/** A price with the decimals of its price step, with the dollar sign ("$64,250.0"). */
export const price = (value: Scaled | string, tick: string): string => `$${fmtPrice(typeof value === 'string' ? value : str(value), tick)}`;

/** A price column cell: no dollar sign (the column header carries the unit). */
export const priceCell = (value: Scaled | string, tick: string): string => fmtPrice(typeof value === 'string' ? value : str(value), tick);

/** An asset size with the decimals of its lot, trailing zeros kept so a column lines up. */
export const size = (value: Scaled | string, lot: string): string =>
  fmtAmount(typeof value === 'string' ? value : str(value), { places: fractionDigits(lot) ?? 3, fixed: true });

/** "+1.84%" from a ratio. */
export const pct = (ratio: Scaled | string, places = 2): string => fmtPct(typeof ratio === 'string' ? ratio : str(ratio), { places });

/** "16.90%" without a sign, for rates and shares. */
export const pctPlain = (ratio: Scaled | string, places = 2): string =>
  fmtPct(typeof ratio === 'string' ? ratio : str(ratio), { places, signed: false });

/** Number of decimals of a step ("0.01" -> 2). */
export const places = (step: string): number => fractionDigits(step) ?? 2;

const stamp = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** An ISO instant in the viewer's own time zone ("Oct 14, 01:42 AM"). */
export const when = (iso: string): string => stamp.format(new Date(iso));

const dayStamp = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
/** An ISO instant as a date in the viewer's own time zone ("Fri, Oct 16"). */
export const day = (iso: string): string => dayStamp.format(new Date(iso));

/** Direction word for a signed scaled value, used for colour classes. */
export const tone = (value: Scaled): 'up' | 'down' | 'flat' => (value > 0n ? 'up' : value < 0n ? 'down' : 'flat');
