/**
 * How a due date is worded, in one place. The enquiry list, the open enquiry and the Follow-ups queue all use it, so one
 * overdue task reads the same everywhere. Days are the founder's local calendar days: anything due yesterday is "yesterday",
 * even when it was only ten minutes ago, and a task due earlier today is "today". Hours are never used for a past date.
 */
const DAY = 86_400_000;
// Built per call, so the founder's clock at that moment is the one used.
const dayMonth = (time: number, withYear: boolean) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' as const } : {}) }).format(
    new Date(time),
  );

const startOfDay = (time: number) => {
  const day = new Date(time);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
};

/** Local calendar days from today to the due date: negative once it is a past day, 0 for today. Null for an unreadable date. */
export function calendarDaysUntil(dueAt: string, now = Date.now()): number | null {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return null;
  // Rounding absorbs the 23- and 25-hour days around a clock change.
  return Math.round((startOfDay(due) - startOfDay(now)) / DAY);
}

export type DueWording = {
  /** "Due today", "Due tomorrow", "Due in 3 days", "Due yesterday", "Due 12 Oct". Empty when the date is unreadable. */
  when: string;
  /** Only once the due time has passed: "Overdue today", "1 day overdue", "2 days overdue". */
  overdue: string | null;
  /** Whole local calendar days past, 0 while not overdue or when it fell due earlier today. */
  overdueDays: number;
};

export function describeDue(dueAt: string, now = Date.now()): DueWording {
  const days = calendarDaysUntil(dueAt, now);
  if (days === null) return { when: '', overdue: null, overdueDays: 0 };
  const time = Date.parse(dueAt);
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  const dated = `Due ${dayMonth(time, !sameYear)}`;
  if (time >= now) {
    if (days === 0) return { when: 'Due today', overdue: null, overdueDays: 0 };
    if (days === 1) return { when: 'Due tomorrow', overdue: null, overdueDays: 0 };
    return { when: days <= 6 ? `Due in ${days} days` : dated, overdue: null, overdueDays: 0 };
  }
  const past = Math.max(0, -days);
  const when = past === 0 ? 'Due today' : past === 1 ? 'Due yesterday' : dated;
  const overdue = past === 0 ? 'Overdue today' : `${past.toLocaleString('en-GB')} ${past === 1 ? 'day' : 'days'} overdue`;
  return { when, overdue, overdueDays: past };
}

/** "2 days overdue", "Overdue today", or null while the due time has not passed. */
export const overdueText = (dueAt: string, now = Date.now()): string | null => describeDue(dueAt, now).overdue;
