/**
 * The amount field's one rule, shared by the field, the Continue guard and the stored-draft loader.
 *
 * Accepted, and nothing else:
 *  - plain digits with an optional decimal point: 150000, 150000.50, 0.5
 *  - a whole number grouped in threes by ONE separator style, comma or space:
 *    150,000  1,250,000.50  150 000
 * Everything else ("1,5", "1.000,50", "1e5", "-5", "1,2,3", "1.5.", "1 250,000", a lone space) is not
 * normalised: it stays as typed and the field reports AMOUNT_ERROR. No guessing between locales.
 */
export const AMOUNT_ERROR = 'Use digits, for example 150,000 or 150000.50';

// Same shape the journey contract validates: no leading zeros, optional decimal part.
export const AMOUNT_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/;
// First group 1-3 digits, then groups of exactly three, one separator style (backreference).
const AMOUNT_GROUPED = /^[1-9][0-9]{0,2}([, ])[0-9]{3}(?:\1[0-9]{3})*(?:\.[0-9]{1,18})?$/;

export type ParsedAmount = { kind: 'empty' | 'valid' | 'invalid'; plain: string };

/** `plain` is the normalised string for a valid amount, and '' otherwise. */
export function parseAmount(raw: string): ParsedAmount {
  if (raw === '') return { kind: 'empty', plain: '' };
  // A no-break or narrow no-break space (pasted from a formatted source) is the same separator as a space.
  // Spaces at either end are ignored; a value of only spaces is not an amount.
  const text = raw.replace(/[  ]/g, ' ').trim();
  if (AMOUNT_DECIMAL.test(text)) return { kind: 'valid', plain: text };
  if (AMOUNT_GROUPED.test(text)) return { kind: 'valid', plain: text.replace(/[, ]/g, '') };
  return { kind: 'invalid', plain: '' };
}

/** What the journey stores: the plain string for a valid amount, the text as typed for anything else. */
export const storedAmount = (raw: string) => {
  const parsed = parseAmount(raw);
  return parsed.kind === 'valid' ? parsed.plain : raw;
};

/** 150000.5 -> "150,000.5". Anything that is not already a plain amount is returned unchanged. */
export function groupAmount(plain: string) {
  if (!AMOUNT_DECIMAL.test(plain)) return plain;
  const [whole, fraction] = plain.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : '.' + fraction);
}
