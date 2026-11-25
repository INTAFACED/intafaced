/** `at` is left out when the service does not record when it happened; the page then says so instead of guessing. */
export type TimelineEvent = { at?: string; title: string; detail?: string };
