import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString } from './bank-call-schemas.js';
import { stepUpApprovalField } from './bank-cards-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `transfers.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_TRANSFERS_SCHEDULE = defineProcedure({
  ...base,
  name: 'bank.transfers.schedule',
  kind: 'mutation',
  path: 'transfers.schedule',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    fromSpaceId: z.string().guid(),
    toSpaceId: z.string().guid(),
    amount: amountString,
    cadence: z.enum(['daily', 'weekly', 'monthly', 'once']),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).optional(),
    scheduleId: z.string().guid(),
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: z.object({ id: z.string(), nextRunAt: z.string() }),
  samples: [
    {
      verdict: 'accept',
      input: {
        fromSpaceId: '11111111-1111-4111-8111-111111111111',
        toSpaceId: '11111111-1111-4111-8111-111111111111',
        amount: '1',
        cadence: 'daily',
        startsAt: '2026-01-01T00:00:00.000Z',
        scheduleId: '11111111-1111-4111-8111-111111111111',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Change a standing order's amount or end date (BK-xfer-10). The caller names the revision it read; an edit at a
 * revision that is no longer current refuses `bank.schedule_revision_conflict`. The recipient, cadence and start do
 * not change. Inside the owner-set cutoff before the next run it refuses `bank.schedule_cutoff`, and while the cutoff
 * is not published, `bank.schedule_edit_cutoff_unset`. Nothing is posted.
 */
export const BANK_TRANSFERS_UPDATE_SCHEDULE = defineProcedure({
  ...base,
  name: 'bank.transfers.updateSchedule',
  kind: 'mutation',
  path: 'transfers.updateSchedule',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      scheduleId: z.string().guid(),
      revision: z.number().int().min(1),
      amount: amountString,
      /** The new last date, or null for "until cancelled". Required, so leaving it out never clears an end. */
      endsAt: z.string().datetime({ offset: true }).nullable(),
      stepUpApprovalId: stepUpApprovalField,
    })
    .strict(),
  output: z.object({
    id: z.string(),
    revision: z.number().int(),
    amount: amountString,
    endsAt: z.string().nullable(),
    nextRunAt: z.string(),
  }),
  samples: [
    {
      verdict: 'accept',
      input: { scheduleId: '11111111-1111-4111-8111-111111111111', revision: 1, amount: '1', endsAt: '2026-01-01T00:00:00.000Z' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
