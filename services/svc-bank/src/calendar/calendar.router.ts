import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { CALENDAR_ITEM_STATUSES, CALENDAR_MAX_DAYS, CALENDAR_SOURCES } from './calendar.js';

/**
 * `bank.calendar.window` (BK-acct-10, J-bank-06 #5): what is dated for the signed person in a window, merged from their
 * standing orders, recurring bills, direct debits, loans and fixed-term earn positions, with how each source answered.
 * Read only; `bank:read`.
 */

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function createCalendarRouter(bank: BankServices, guard: Guard) {
  return router({
    window: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /** The first day, `YYYY-MM-DD`, read as UTC midnight. */
            from: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .refine((day) => {
                // A date that does not exist (30 February) would roll over to another day; it is refused instead.
                const at = new Date(`${day}T00:00:00.000Z`);
                return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === day;
              }, 'not a calendar date'),
            days: z.number().int().min(1).max(CALENDAR_MAX_DAYS),
            /** The page size each source reads with. Required: blank is not a size. */
            limit: z.number().int().min(1).max(200),
          })
          .strict(),
      )
      .output(
        z.object({
          from: z.string(),
          to: z.string(),
          items: z.array(
            z.object({
              source: z.enum(CALENDAR_SOURCES),
              refId: z.string(),
              key: z.string(),
              date: z.string(),
              label: z.string().nullable(),
              assetId: z.string(),
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
      )
      .query(({ ctx, input }) =>
        guard(() =>
          bank.calendar.window({
            userId: ctx.principal.userId,
            from: new Date(`${input.from}T00:00:00.000Z`),
            days: input.days,
            limit: input.limit,
          }),
        ),
      ),
  });
}
