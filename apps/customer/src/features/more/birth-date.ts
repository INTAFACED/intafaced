/**
 * The Blueprint session's optional birth date as three pickers (day, month by name, year) in place of the browser's date
 * input, whose order (mm/dd/yyyy in a US browser) follows the browser, not the page's language.
 */
export type BirthDateOption = { value: string; label: string };

const OLDEST_YEARS = 120;

/** The day, month and year choices, each led by "not given"; months are named in the page's language. */
export function birthDateOptions(locale: string, notGiven: string, thisYear: number) {
  const none: BirthDateOption = { value: '', label: notGiven };
  const monthName = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const days = Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => ({ value: d, label: d }));
  const months = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: monthName.format(Date.UTC(2000, i, 1)) }));
  const years = Array.from({ length: OLDEST_YEARS + 1 }, (_, i) => String(thisYear - i)).map((y) => ({ value: y, label: y }));
  return { days: [none, ...days], months: [none, ...months], years: [none, ...years] };
}
