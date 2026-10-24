import { z } from 'zod';

export class OutreachError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'OutreachError';
  }
}
export const outreachConfigSchema = z
  .object({
    founders: z
      .array(
        z
          .string()
          .guid()
          .transform((value) => value.toLowerCase()),
      )
      .length(2)
      .refine((x) => new Set(x).size === 2),
    initialOwnerUserId: z
      .string()
      .guid()
      .transform((value) => value.toLowerCase()),
    continuationTtlSeconds: z.number().int().min(60).max(2592000),
    timeZone: z.string().refine((x) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: x });
        return true;
      } catch {
        return false;
      }
    }),
    businessWeekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((x) => new Set(x).size === x.length),
    reviewHour: z.number().int().min(0).max(23),
    reviewMinute: z.number().int().min(0).max(59),
    retention: z
      .object({ publishedPolicy: z.literal('six_calendar_months_v1'), automationEnabled: z.boolean() })
      .strict()
      .optional(),
  })
  .refine((x) => x.founders.includes(x.initialOwnerUserId));
export type OutreachConfig = z.infer<typeof outreachConfigSchema>;

/** Find the next configured business date and local clock, including DST transitions. */
export function nextReviewAt(now: Date, config: OutreachConfig): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (d: Date) => Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const today = parts(now);
  const date = new Date(Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day)));
  for (let day = 1; day <= 8; day++) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay() || 7;
    if (!config.businessWeekdays.includes(weekday)) continue;
    const targetDate = date.toISOString().slice(0, 10);
    // Use the earliest valid local clock at or after the configured clock on this business date.
    // Spring-forward gaps move to the first valid following clock; folds choose the first occurrence.
    let selected: Date | null = null;
    let selectedClock = Infinity;
    const targetClock = config.reviewHour * 60 + config.reviewMinute;
    for (let minute = -14 * 60; minute <= 36 * 60; minute++) {
      const candidate = new Date(date.getTime() + minute * 60000);
      const p = parts(candidate);
      const localClock = Number(p.hour) * 60 + Number(p.minute);
      if (`${p.year}-${p.month}-${p.day}` !== targetDate || localClock < targetClock) continue;
      if (localClock === targetClock) return candidate.toISOString();
      if (localClock < selectedClock) {
        selected = candidate;
        selectedClock = localClock;
      }
    }
    if (selected) return selected.toISOString();
    // A whole missing civil date cannot silently become a later review date.
    throw new OutreachError('ops.crm.schedule_unavailable');
  }
  throw new OutreachError('ops.crm.schedule_unavailable');
}
