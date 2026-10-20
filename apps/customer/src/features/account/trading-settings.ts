import { dec } from '../../data/decimal';

/** Most quick-size buttons the desk shows. */
export const QUICK_SIZES_MAX = 6;

export type QuickSizes = { ok: true; sizes: string[] } | { ok: false; reason: 'tooMany' | 'invalid' };

/**
 * A size list typed as "0.1, 0.5 1". Each entry is a positive exact decimal with at most 18 places; a repeat is dropped;
 * a blank text is the empty list, which shows no buttons. Nothing here becomes a JS number.
 */
export function parseQuickSizes(text: string): QuickSizes {
  const entries = text.split(/[\s,;]+/).filter((entry) => entry !== '');
  const sizes: string[] = [];
  for (const entry of entries) {
    if (!/^\d+(\.\d{1,18})?$/.test(entry)) return { ok: false, reason: 'invalid' };
    const value = dec(entry);
    if (value === null || value <= 0n) return { ok: false, reason: 'invalid' };
    if (!sizes.includes(entry)) sizes.push(entry);
  }
  return sizes.length > QUICK_SIZES_MAX ? { ok: false, reason: 'tooMany' } : { ok: true, sizes };
}

export const quickSizesText = (sizes: readonly string[]): string => sizes.join(', ');

/** Whether a size fits the market's amount precision, so a button for it never types an amount the desk would round or refuse. */
export function fitsPlaces(size: string, places: number): boolean {
  const fraction = size.split('.')[1] ?? '';
  return fraction.length <= places;
}
