/** The money calendar's sources (BK-acct-10), on their own so a TEST switch can name one without the calendar's reads. */
export const CALENDAR_SOURCES = ['standing_orders', 'bills', 'direct_debits', 'loans', 'earn'] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];
