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

/**
 * A move into a space (`transferId` is the client's, so a retried request is the same transfer, not a second one). The
 * reply names the ledger's transaction, or, where the partner bank holds both sides, the partner's one move and no ledger
 * transaction: exactly one book made it, and a reply naming neither, or both, is never a confirmation.
 */
export const BANK_TRANSFERS_CREATE = defineProcedure({
  ...base,
  name: 'bank.transfers.create',
  kind: 'mutation',
  path: 'transfers.create',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    transferId: z.string().min(8).max(64),
    fromSpaceId: z.string().guid(),
    toSpaceId: z.string().guid(),
    amount: amountString,
    note: z
      .string()
      .min(1)
      .max(140)
      // No character below a space (U+0000 to U+001F), compared without a control-character regex.
      .refine((value) => ![...value].some((c) => c < ' '), 'note has a control character')
      .optional(),
    reference: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\x20-\x7E]+$/)
      .optional(),
    stepUpApprovalId: stepUpApprovalField,
  }),
  checks: { no_control_characters: { at: 'input.note', says: 'note has a control character' } },
  output: z.object({
    /** The ledger transaction on the custodial layer. Null when the partner bank made the move. */
    ledgerTxId: z.string().min(1).nullable(),
    amount: amountString,
    /** The partner bank's one move under this transfer's key, with its label (TEST) and time. Null on the ledger path. */
    partnerMove: z
      .object({ id: z.string().min(1), label: z.string().min(1), movedAt: z.string() })
      .nullable()
      .optional(),
  }),
  accept: {
    oneBook: {
      says: 'exactly one book made the move: a ledger transaction, or the partner bank move, never neither or both',
      holds: (reply) => {
        const read = z.object({ ledgerTxId: z.string().nullable(), partnerMove: z.unknown().optional() }).safeParse(reply);
        return read.success && (read.data.ledgerTxId === null) === (read.data.partnerMove != null);
      },
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        transferId: 'transfer-1',
        fromSpaceId: '11111111-1111-4111-8111-111111111111',
        toSpaceId: '22222222-2222-4222-8222-222222222222',
        amount: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'no_control_characters',
      input: {
        transferId: 'transfer-1',
        fromSpaceId: '11111111-1111-4111-8111-111111111111',
        toSpaceId: '22222222-2222-4222-8222-222222222222',
        amount: '1',
        note: 'a\x07b',
      },
    },
  ],
});

/** A standing or one-off order paying another person's main space. */
export const BANK_TRANSFERS_SCHEDULE_TO_USER = defineProcedure({
  ...base,
  name: 'bank.transfers.scheduleToUser',
  kind: 'mutation',
  path: 'transfers.scheduleToUser',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    fromSpaceId: z.string().guid(),
    toUserId: z.string().min(1).max(64),
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
        toUserId: 'user-2',
        amount: '1',
        cadence: 'monthly',
        startsAt: '2026-01-01T00:00:00.000Z',
        scheduleId: '11111111-1111-4111-8111-111111111111',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
