// A plan limit's value in the words a developer reads: time in seconds, sizes in KB or MB, counts with their thousands
// grouped. The stored value stays the exact whole number (`data-value`); only the words change.

/** "1234567" → "1,234,567". A value that is not a whole number is returned as it is. */
export function grouped(value: string): string {
  return /^\d+$/.test(value) ? value.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : value;
}

/** `value` divided by 10^`places`, exact, with trailing zeros dropped: ("2500", 3) → "2.5". */
function scaled(value: string, places: number): string {
  const padded = value.padStart(places + 1, '0');
  const whole = grouped(padded.slice(0, -places).replace(/^0+(?=\d)/, ''));
  const fraction = padded.slice(-places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export type LimitUnit = 'milliseconds' | 'bytes' | 'characters' | 'count';

export interface LimitWords {
  seconds: (n: string) => string;
  oneSecond: string;
  bytes: (n: string) => string;
  kb: (n: string) => string;
  mb: (n: string) => string;
  characters: (n: string) => string;
}

/** The words for one limit's whole-number value in its unit; a value that is not a whole number is shown as it is. */
export function limitText(value: string, unit: LimitUnit, words: LimitWords): string {
  if (!/^\d+$/.test(value)) return value;
  if (unit === 'milliseconds') {
    const seconds = scaled(value, 3);
    return seconds === '1' ? words.oneSecond : words.seconds(seconds);
  }
  if (unit === 'characters') return words.characters(grouped(value));
  if (unit === 'count') return grouped(value);
  if (value.length > 6) return words.mb(scaled(value, 6));
  if (value.length > 3) return words.kb(scaled(value, 3));
  return words.bytes(value);
}

/** A time in the reader's own time zone and language: "23 Nov 2026, 15:19", with `seconds` "23 Nov 2026, 15:19:05". */
export function readTime(iso: string, locale: string, seconds = false): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: seconds ? 'medium' : 'short' }).format(at);
}
