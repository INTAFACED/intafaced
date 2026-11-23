import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString } from './bank-earn-procedures.js';
import { stepUpApprovalField } from './bank-cards-procedures.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `transfers.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Why a send is held, as the customer is told it. One class today; the database check lists the same ones. */
export const SEND_REVIEW_REASONS = ['amount_over_review_line'] as const;

/** A personal send the owner's review holds (PP-send-request-10), as its sender reads it: never the rule's line. */
export const heldSendOutput = z.object({
  transferId: z.string(),
  status: z.enum(['in_review', 'released', 'rejected']),
  reasonClass: z.enum(SEND_REVIEW_REASONS),
  amount: amountString,
  assetId: assetIdSchema,
  note: z.string().nullable(),
  reference: z.string().nullable(),
  requestId: z.string().guid().nullable(),
  toHandle: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
});

/** What actually ran, and why anything did not. The user's answer to "where is my rent". */
export const BANK_TRANSFERS_EXECUTIONS = defineProcedure({
  ...base,
  name: 'bank.transfers.executions',
  kind: 'query',
  path: 'transfers.executions',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({
    scheduleId: z.string().guid(),
    /**
     * Page size. Optional so omit reaches `bank.executions_list_limit_unset`
     * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
     */
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.array(
    z.object({
      occurrence: z.number().int(),
      amount: amountString,
      status: z.string(),
      ledgerTxId: z.string().nullable(),
      /** The partner bank's reference when it made this occurrence's move. Null on the ledger path. */
      partnerMoveId: z.string().nullable(),
      rejectionCode: z.string().nullable(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: { scheduleId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_TRANSFERS_LIST_SCHEDULES = defineProcedure({
  ...base,
  name: 'bank.transfers.listSchedules',
  kind: 'query',
  path: 'transfers.listSchedules',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      /**
       * Page size. Optional so omit reaches `bank.schedules_list_limit_unset`
       * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
       */
      limit: z.number().int().min(1).max(200).optional(),
      /** Only the orders paying into this one of the caller's own spaces (BK-pots-02). */
      toSpaceId: z.string().guid().optional(),
    })
    .optional(),
  output: z.array(
    z.object({
      id: z.string(),
      assetId: assetIdSchema,
      amount: amountString,
      cadence: z.string(),
      startsAt: z.string(),
      endsAt: z.string().nullable(),
      nextRunAt: z.string(),
      status: z.string(),
      /** The revision an edit must name. */
      revision: z.number().int(),
      /** The caller's own space the order pays from. */
      fromSpaceId: z.string(),
      /** The caller's own space it pays into, or null when it pays another person. */
      toSpaceId: z.string().nullable(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Limits and fee for a personal send, before the review step.
 * Refuses when nothing is published. Never fills a zero fee or a default cap.
 */
export const BANK_TRANSFERS_QUOTE = defineProcedure({
  ...base,
  name: 'bank.transfers.quote',
  kind: 'query',
  path: 'transfers.quote',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ assetId: assetIdSchema.min(1).max(16), amount: amountString }),
  output: z.object({
    assetId: assetIdSchema,
    amount: amountString,
    perTransferLimit: amountString,
    dailyLimit: amountString,
    spentToday: amountString,
    /** What is left of today's limit: the daily limit less what was sent today, never below zero. */
    remainingToday: amountString,
    fee: amountString,
    feeBlocker: z.string().nullable(),
    /**
     * The partner's fee on the move (CUSTODY-DELTA §1.3). Absent: no partner reports one for this send. Null: the
     * partner moves it and has not said what it costs, read as "not known", never 0.
     */
    networkFee: amountString.nullable().optional(),
    withinPerTransfer: z.boolean(),
    withinDaily: z.boolean(),
  }),
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', amount: '1' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The sender's own send that the review holds (PP-send-request-10): In review with its reason class, or how the review
 * ended. Nobody else can read it, and a stranger gets the same not-found as a missing id.
 */
export const BANK_TRANSFERS_HELD = defineProcedure({
  ...base,
  name: 'bank.transfers.held',
  kind: 'query',
  path: 'transfers.held',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ transferId: z.string().min(8).max(64) }),
  output: heldSendOutput,
  samples: [
    { verdict: 'accept', input: { transferId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_TRANSFERS_TO_USER = defineProcedure({
  ...base,
  name: 'bank.transfers.toUser',
  kind: 'mutation',
  path: 'transfers.toUser',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    transferId: z.string().min(8).max(64),
    fromSpaceId: z.string().guid(),
    toUserId: z.string().min(1).max(64),
    amount: amountString,
    /** Recipient-visible plain text. Omitted means no note. */
    note: z.string().max(140).optional(),
    /** Printable payment reference. Omitted means none. */
    reference: z.string().max(64).optional(),
    /** Settles this open payment request. One payment, one request. */
    requestId: z.string().guid().optional(),
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: z.object({
    /** The ledger transaction on the custodial layer; null when the partner bank moved it. */
    ledgerTxId: z.string().nullable(),
    partnerMove: z.object({ id: z.string(), label: z.string() }).nullable(),
    amount: amountString,
    note: z.string().nullable(),
    reference: z.string().nullable(),
    requestId: z.string().guid().nullable(),
  }),
  samples: [
    {
      verdict: 'accept',
      input: { transferId: 'ethereum', fromSpaceId: '11111111-1111-4111-8111-111111111111', toUserId: 'USDC', amount: '1' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_TRANSFERS_CANCEL = defineProcedure({
  ...base,
  name: 'bank.transfers.cancel',
  kind: 'mutation',
  path: 'transfers.cancel',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ scheduleId: z.string().guid() }),
  output: z.object({ cancelled: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { scheduleId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
