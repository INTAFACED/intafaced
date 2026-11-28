import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString } from './bank-call-schemas.js';
import { assetIdSchema } from './asset-id.js';

/** svc-bank `calendar.*`, one record per call: every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Where a dated item comes from. */
export const CALENDAR_SOURCES = ['standing_orders', 'bills', 'direct_debits', 'loans', 'earn'] as const;
/** What became of a dated item. */
export const CALENDAR_ITEM_STATUSES = ['upcoming', 'paused', 'done', 'failed', 'skipped', 'refused'] as const;
/** The longest window one read covers, in days. */
export const CALENDAR_MAX_DAYS = 62;

/**
 * `bank.calendar.window` (BK-acct-10, J-bank-06 #5): what is dated for the signed person in a window, merged from their
 * standing orders, recurring bills, direct debits, loans and fixed-term earn positions, with how each source answered.
 */
export const BANK_CALENDAR_WINDOW = defineProcedure({
  ...base,
  name: 'bank.calendar.window',
  kind: 'query',
  path: 'calendar.window',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      /**
       * The first day, `YYYY-MM-DD`, read as UTC midnight. A date that does not exist (30 February) would roll over to
       * another day; it is refused instead.
       */
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine((day) => {
          const at = new Date(`${day}T00:00:00.000Z`);
          return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === day;
        }, 'not a calendar date'),
      days: z.number().int().min(1).max(CALENDAR_MAX_DAYS),
      /** The page size each source reads with. Required: blank is not a size. */
      limit: z.number().int().min(1).max(200),
    })
    .strict(),
  checks: { calendar_day: { at: 'input.from', says: 'not a calendar date' } },
  output: z.object({
    from: z.string(),
    to: z.string(),
    items: z.array(
      z.object({
        source: z.enum(CALENDAR_SOURCES),
        refId: z.string(),
        key: z.string(),
        date: z.string(),
        label: z.string().nullable(),
        assetId: assetIdSchema,
        amount: amountString.nullable(),
        status: z.enum(CALENDAR_ITEM_STATUSES),
        reasonCode: z.string().nullable(),
      }),
    ),
    sources: z.array(
      z.object({
        source: z.enum(CALENDAR_SOURCES),
        state: z.enum(['ok', 'not_set', 'refused', 'unavailable']),
        count: z.number().int(),
        code: z.string().nullable(),
        complete: z.boolean(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { from: '2026-01-01', days: 31, limit: 50 } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'calendar_day', input: { from: '2026-02-30', days: 31, limit: 50 } },
  ],
});
