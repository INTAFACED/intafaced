/**
 * The amount field's one rule, shared by the field, the Continue guard and the stored-draft loader.
 *
 * Accepted, and nothing else:
 *  - plain digits with an optional decimal point: 150000, 150000.50, 0.5
 *  - a whole number grouped in threes by ONE separator style, comma or space:
 *    150,000  1,250,000.50  150 000
 * Everything else ("1,5", "1e5", "-5", "1,2,3", "1.5.", "1 250,000", a lone space) is not
 * normalised: it stays as typed and the field reports AMOUNT_ERROR. No guessing between locales.
 *
 * Two more shapes are neither accepted nor refused, because each can be read two ways:
 *  - a number that could be written the Indonesian or European way, "150.000", "1.500.000" or "150.000,50" (dots as
 *    thousands). It could also be a decimal ("150.000" is 150);
 *  - a grouped number followed by a dot and exactly three digits, "1,500.000" or "1 500.000" (the dot as one more thousands
 *    separator would make it 1,500,000; as a decimal point it is 1,500).
 * Both are AMBIGUOUS: the visitor is asked what they meant (amountAmbiguity), nothing is guessed and nothing is sent until
 * they answer.
 */
export const AMOUNT_ERROR = 'Use digits, for example 150,000 or 150000.50';
/** The CRM records at most 15 whole digits (the intake contract's cap); anything longer is refused here, before sending. */
export const AMOUNT_MAX_WHOLE_DIGITS = 15;
export const AMOUNT_TOO_LARGE = 'That is more digits than we can record. Use at most 15 digits before the decimal point.';

// Same shape the journey contract validates: no leading zeros, optional decimal part.
export const AMOUNT_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/;
// First group 1-3 digits, then groups of exactly three, one separator style (backreference).
const AMOUNT_GROUPED = /^[1-9][0-9]{0,2}([, ])[0-9]{3}(?:\1[0-9]{3})*(?:\.[0-9]{1,18})?$/;

// Dots as thousands separators: first group 1-3 digits, then one or more groups of exactly three, then optionally ",d" or ",dd".
const AMOUNT_AMBIGUOUS = /^([1-9][0-9]{0,2})((?:\.[0-9]{3})+)(?:,([0-9]{1,2}))?$/;

// A grouped number (one separator style) followed by "." and exactly three digits: "1,500.000", "150 000.000".
const AMOUNT_MIXED = /^([1-9][0-9]{0,2})([, ])([0-9]{3}(?:\2[0-9]{3})*)\.([0-9]{3})$/;

export type ParsedAmount = { kind: 'empty' | 'valid' | 'invalid' | 'ambiguous'; plain: string; tooLarge?: true };

/** A no-break or narrow no-break space (pasted from a formatted source) is the same separator as a space; spaces at either end are ignored. */
const clean = (raw: string) => raw.replace(/[\u00a0\u202f]/g, ' ').trim();

/** `plain` is the normalised string for a valid amount, and '' otherwise. An ambiguous amount is not valid until it is resolved. */
export function parseAmount(raw: string): ParsedAmount {
  if (raw === '') return { kind: 'empty', plain: '' };
  // A value of only spaces is not an amount.
  const text = clean(raw);
  if (AMOUNT_AMBIGUOUS.test(text) || AMOUNT_MIXED.test(text)) return { kind: 'ambiguous', plain: '' };
  const plain = AMOUNT_DECIMAL.test(text) ? text : AMOUNT_GROUPED.test(text) ? text.replace(/[, ]/g, '') : null;
  if (plain === null) return { kind: 'invalid', plain: '' };
  if (plain.split('.')[0]!.length > AMOUNT_MAX_WHOLE_DIGITS) return { kind: 'invalid', plain: '', tooLarge: true };
  return { kind: 'valid', plain };
}

/** The message for a typed amount that is not valid, or '' when there is nothing to report. */
export function amountError(raw: string): string {
  const parsed = parseAmount(raw);
  if (parsed.kind !== 'invalid') return '';
  return parsed.tooLarge ? AMOUNT_TOO_LARGE : AMOUNT_ERROR;
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

const ONES = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
// British style: "and" before the tens and units that follow a hundred ("one hundred and fifty"), and before a final
// group of under a hundred that follows a larger one ("one thousand and five"). Round groups take none ("one million five
// hundred thousand").
const below1000 = (n: number): string => {
  const parts: string[] = [];
  if (n >= 100) parts.push(ONES[Math.floor(n / 100)] + ' hundred');
  const rest = n % 100;
  if (rest > 0 && n >= 100) parts.push('and');
  if (rest >= 20) parts.push(TENS[Math.floor(rest / 10)] + (rest % 10 ? '-' + ONES[rest % 10] : ''));
  else if (rest > 0) parts.push(ONES[rest]);
  return parts.join(' ');
};

/** 150000 -> "one hundred and fifty thousand". Whole numbers below one billion only (three comma groups at most); otherwise null. */
export function spellAmount(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 999_999_999) return null;
  const parts: string[] = [];
  for (const [size, name] of [
    [1_000_000, 'million'],
    [1_000, 'thousand'],
    [1, ''],
  ] as const) {
    const chunk = Math.floor(n / size) % 1000;
    if (!chunk) continue;
    if (!name && chunk < 100 && parts.length) parts.push('and');
    parts.push(below1000(chunk) + (name ? ' ' + name : ''));
  }
  return parts.join(' ');
}

export interface AmountAmbiguity {
  /** The amount if the dots were thousands separators, as a plain string: "150000", "150000.50". */
  yes: string;
  /** The same, shown with commas: "150,000". */
  yesText: string;
  /** The words for `yes`, only for a whole number of three comma groups or fewer: "one hundred and fifty thousand". */
  words: string | null;
  /** The amount if the dot was a decimal point, as a plain string ("150" for "150.000"). Only one dot-group can be read that way. */
  no: string | null;
  noText: string | null;
}

/**
 * Null unless `raw` could be read two ways: dots-as-thousands ("150.000", "1.500.000", "150.000,50") or a grouped number
 * with a dot and three digits ("1,500.000"). Never decides; it only describes both readings.
 */
export function amountAmbiguity(raw: string): AmountAmbiguity | null {
  const text = clean(raw);
  const mixed = AMOUNT_MIXED.exec(text);
  if (mixed) {
    const [, head, separator, rest, fraction] = mixed;
    const whole = head + rest.split(separator).join('');
    const yes = whole + fraction;
    // "1,500.000" read as a decimal is 1,500; "1,500.500" is 1,500.5. A trailing zero is not kept.
    const decimal = `${whole}.${fraction}`.replace(/\.?0+$/, '');
    return { yes, yesText: groupAmount(yes), words: spellAmount(Number(yes)), no: decimal, noText: groupAmount(decimal) };
  }
  const match = AMOUNT_AMBIGUOUS.exec(text);
  if (!match) return null;
  const [, head, dotted, cents] = match;
  const whole = head + dotted.replace(/\./g, '');
  const yes = cents === undefined ? whole : `${whole}.${cents}`;
  const commaGroups = 1 + dotted.length / 4;
  // "150.000" read as a decimal is 150; "150.500" is 150.5. A trailing zero is not kept.
  const decimal = dotted.length === 4 && cents === undefined ? `${head}.${dotted.slice(1)}`.replace(/\.?0+$/, '') : null;
  return {
    yes,
    yesText: groupAmount(yes),
    words: cents === undefined && commaGroups <= 3 ? spellAmount(Number(whole)) : null,
    no: decimal,
    noText: decimal,
  };
}
