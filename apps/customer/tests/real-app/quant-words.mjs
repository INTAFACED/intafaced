// The words Algo dev's usage and limits views write a whole number in, written here from the views' own rule
// (apps/customer/src/features/quant/limit-words.ts, limits-copy.ts), so a journey checks the text against the raw value.

/** "1234567" → "1,234,567". */
export const grouped = (value) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Bytes in KB or MB (1 MB is 1,000,000 bytes), exact with trailing zeros dropped; any other count with its thousands grouped. */
export function inWords(value, unit) {
  if (unit !== 'bytes') return grouped(value);
  const places = value.length > 6 ? 6 : value.length > 3 ? 3 : 0;
  if (places === 0) return `${value} bytes`;
  const whole = grouped(value.slice(0, -places));
  const fraction = value.slice(-places).replace(/0+$/, '');
  return `${fraction ? `${whole}.${fraction}` : whole} ${places === 6 ? 'MB' : 'KB'}`;
}
