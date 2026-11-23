import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, type Refusals, type RefusalStatus } from './procedure.js';

/**
 * svc-bank `personalRequest.*`: ask a person to pay you, one record per call. The signed-in user is the payee;
 * `payerUserId` is who is asked. Making, reminding, declining or reporting a request moves no money: paying is one send
 * under the request's own key (`request:<requestId>`). svc-bank mounts each from here (`personal-request.router.ts`) and
 * the customer app calls each by its record.
 */

const amount = z.string().regex(/^\d+(\.\d{1,18})?$/);
export const PERSONAL_REQUEST_STATUSES = ['open', 'paid', 'declined', 'cancelled', 'expired'] as const;
const requestStatus = z.enum(PERSONAL_REQUEST_STATUSES);
/** What a person asked may report a request as (svc-bank's `REPORT_REASONS`). */
export const PERSONAL_REQUEST_REPORT_REASONS = ['scam', 'spam', 'harassment', 'other'] as const;

export const personalRequestSchema = z.object({
  requestId: z.string().guid(),
  payeeUserId: z.string(),
  payerUserId: z.string(),
  payeeHandle: z.string().nullable(),
  payerHandle: z.string().nullable(),
  assetId: assetIdSchema,
  amount,
  note: z.string().nullable(),
  expiresAt: z.string().datetime(),
  status: requestStatus,
  ledgerTxId: z.string().nullable(),
  createdAt: z.string().datetime(),
  notice: z.object({ delivered: z.boolean(), blocker: z.string().nullable() }),
});
export type PersonalRequest = z.output<typeof personalRequestSchema>;

/** The asker's reminders in the owner's window and when the next may go (PP-send-request-13). */
export const personalRequestReminderSchema = z.object({
  sentInWindow: z.number().int().min(0),
  cap: z.number().int().min(1),
  windowSeconds: z.number().int().min(1),
  nextAllowedAt: z.string().datetime().nullable(),
});
export type PersonalRequestReminder = z.output<typeof personalRequestReminderSchema>;

/** The payer's own report on a request and whether they blocked the asker. */
export const personalRequestSafetySchema = z.object({
  caseId: z.string().guid(),
  reason: z.enum(PERSONAL_REQUEST_REPORT_REASONS),
  state: z.enum(['open', 'closed']),
  openedAt: z.string().datetime(),
  blocked: z.boolean(),
});
export type PersonalRequestSafety = z.output<typeof personalRequestSafetySchema>;

/** Each refusal by its code, with the status svc-bank's error table sends it with (`transfers/bank-errors.ts`, `shared-bank-errors.ts`). */
const STATUS = {
  'bank.personal_request_not_found': 'NOT_FOUND',
  'bank.personal_request_closed': 'CONFLICT',
  'bank.personal_request_expired': 'CONFLICT',
  'bank.personal_request_not_payer': 'FORBIDDEN',
  'bank.personal_request_not_payee': 'FORBIDDEN',
  'bank.personal_request_claim_held': 'CONFLICT',
  'bank.personal_request_conflict': 'CONFLICT',
  'bank.personal_request_self': 'BAD_REQUEST',
  'bank.personal_request_list_limit_unset': 'BAD_REQUEST',
  'bank.personal_request_payer_unknown': 'NOT_FOUND',
  'bank.personal_request_unavailable': 'PRECONDITION_FAILED',
  'bank.personal_request_remind_capped': 'TOO_MANY_REQUESTS',
  'bank.personal_request_report_reason': 'BAD_REQUEST',
  'bank.personal_note_invalid': 'BAD_REQUEST',
  'bank.recipient_cannot_receive': 'PRECONDITION_FAILED',
  'bank.reminder_policy_unset': 'PRECONDITION_FAILED',
  'bank.party_handles_unset': 'PRECONDITION_FAILED',
  'bank.party_handles_unavailable': 'SERVICE_UNAVAILABLE',
} as const satisfies Record<string, RefusalStatus>;
type Code = keyof typeof STATUS;
const refuse = (...codes: Code[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

/** A request read by one of its two parties: anyone else is told it does not exist. */
const ONE_REQUEST = ['bank.personal_request_not_found'] as const;
/** Closing an open request: the right party, still open, no payment in flight. */
const CLOSE = [
  ...ONE_REQUEST,
  'bank.personal_request_closed',
  'bank.personal_request_expired',
  'bank.personal_request_claim_held',
] as const;

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'bank:read', module: 'bank' } as const;
const WRITE = { caller: 'scope', scope: 'bank:write', module: 'bank' } as const;
const REQUEST_ID = 'b3a7c1e2-4d5f-4a6b-8c9d-0e1f2a3b4c5d';
const byId = z.object({ requestId: z.string().guid() });
const idempotencyKey = z.string().min(8).max(64);

export const BANK_PERSONAL_REQUEST_CREATE = defineProcedure({
  ...base,
  name: 'bank.personalRequest.create',
  kind: 'mutation',
  path: 'personalRequest.create',
  access: WRITE,
  refusals: refuse(
    'bank.personal_request_self',
    'bank.personal_request_expired',
    'bank.personal_request_conflict',
    'bank.personal_request_not_found',
    'bank.personal_request_unavailable',
    'bank.personal_request_payer_unknown',
    'bank.personal_note_invalid',
    'bank.recipient_cannot_receive',
    'bank.party_handles_unset',
    'bank.party_handles_unavailable',
  ),
  input: z.object({
    payerUserId: z.string().guid(),
    assetId: assetIdSchema.min(1).max(16),
    amount,
    note: z.string().max(140).optional(),
    expiresAt: z.string().datetime({ offset: true }),
    idempotencyKey,
  }),
  output: personalRequestSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        payerUserId: REQUEST_ID,
        assetId: 'USDT',
        amount: '12.5',
        expiresAt: '2099-01-01T00:00:00Z',
        idempotencyKey: 'request-create-1',
      },
    },
    {
      verdict: 'refuse',
      input: {
        payerUserId: REQUEST_ID,
        assetId: 'USDT',
        amount: '-1',
        expiresAt: '2099-01-01T00:00:00Z',
        idempotencyKey: 'request-create-1',
      },
    },
    {
      verdict: 'refuse',
      input: {
        payerUserId: 'someone',
        assetId: 'USDT',
        amount: '1',
        expiresAt: '2099-01-01T00:00:00Z',
        idempotencyKey: 'request-create-1',
      },
    },
  ],
});

export const BANK_PERSONAL_REQUEST_LIST = defineProcedure({
  ...base,
  name: 'bank.personalRequest.list',
  kind: 'query',
  path: 'personalRequest.list',
  access: READ,
  refusals: refuse('bank.personal_request_list_limit_unset'),
  input: z.object({
    direction: z.enum(['incoming', 'outgoing']),
    status: requestStatus.optional(),
    /** Optional so a missing limit reaches `bank.personal_request_list_limit_unset`, never a default. */
    limit: z.number().int().min(1).max(100).optional(),
  }),
  output: z.array(personalRequestSchema),
  samples: [
    { verdict: 'accept', input: { direction: 'incoming', limit: 50 } },
    { verdict: 'accept', input: { direction: 'outgoing', status: 'open', limit: 100 } },
    { verdict: 'refuse', input: { direction: 'sideways', limit: 50 } },
    { verdict: 'refuse', input: { direction: 'incoming', limit: 101 } },
  ],
});

export const BANK_PERSONAL_REQUEST_GET = defineProcedure({
  ...base,
  name: 'bank.personalRequest.get',
  kind: 'query',
  path: 'personalRequest.get',
  access: READ,
  refusals: refuse(...ONE_REQUEST),
  input: byId,
  output: personalRequestSchema,
  samples: [
    { verdict: 'accept', input: { requestId: REQUEST_ID } },
    { verdict: 'refuse', input: { requestId: 'not-a-request' } },
  ],
});

export const BANK_PERSONAL_REQUEST_CANCEL = defineProcedure({
  ...base,
  name: 'bank.personalRequest.cancel',
  kind: 'mutation',
  path: 'personalRequest.cancel',
  access: WRITE,
  refusals: refuse(...CLOSE, 'bank.personal_request_not_payee'),
  input: byId,
  output: personalRequestSchema,
  samples: [
    { verdict: 'accept', input: { requestId: REQUEST_ID } },
    { verdict: 'refuse', input: {} },
  ],
});

export const BANK_PERSONAL_REQUEST_DECLINE = defineProcedure({
  ...base,
  name: 'bank.personalRequest.decline',
  kind: 'mutation',
  path: 'personalRequest.decline',
  access: WRITE,
  refusals: refuse(...CLOSE, 'bank.personal_request_not_payer'),
  input: byId,
  output: personalRequestSchema,
  samples: [
    { verdict: 'accept', input: { requestId: REQUEST_ID } },
    { verdict: 'refuse', input: { requestId: '' } },
  ],
});

export const BANK_PERSONAL_REQUEST_REMIND = defineProcedure({
  ...base,
  name: 'bank.personalRequest.remind',
  kind: 'mutation',
  path: 'personalRequest.remind',
  access: WRITE,
  refusals: refuse(
    ...CLOSE,
    'bank.personal_request_not_payee',
    'bank.personal_request_unavailable',
    'bank.personal_request_remind_capped',
    'bank.reminder_policy_unset',
  ),
  input: z.object({ requestId: z.string().guid(), idempotencyKey }),
  output: personalRequestSchema.extend({ reminder: personalRequestReminderSchema }),
  samples: [
    { verdict: 'accept', input: { requestId: REQUEST_ID, idempotencyKey: 'request-remind-1' } },
    { verdict: 'refuse', input: { requestId: REQUEST_ID, idempotencyKey: 'short' } },
  ],
});

export const BANK_PERSONAL_REQUEST_REMINDERS = defineProcedure({
  ...base,
  name: 'bank.personalRequest.reminders',
  kind: 'query',
  path: 'personalRequest.reminders',
  access: READ,
  refusals: refuse(...ONE_REQUEST, 'bank.personal_request_not_payee', 'bank.reminder_policy_unset'),
  input: byId,
  output: personalRequestReminderSchema,
  samples: [
    { verdict: 'accept', input: { requestId: REQUEST_ID } },
    { verdict: 'refuse', input: { requestId: 42 } },
  ],
});

export const BANK_PERSONAL_REQUEST_REPORT = defineProcedure({
  ...base,
  name: 'bank.personalRequest.report',
  kind: 'mutation',
  path: 'personalRequest.report',
  access: WRITE,
  // An open request is declined first, so the decline's own refusals can leave too.
  refusals: refuse(...CLOSE, 'bank.personal_request_not_payer', 'bank.personal_request_report_reason'),
  input: z.object({ requestId: z.string().guid(), reason: z.enum(PERSONAL_REQUEST_REPORT_REASONS), block: z.boolean() }),
  output: z.object({ request: personalRequestSchema, safety: personalRequestSafetySchema }),
  samples: [
    { verdict: 'accept', input: { requestId: REQUEST_ID, reason: 'scam', block: true } },
    { verdict: 'refuse', input: { requestId: REQUEST_ID, reason: 'boredom', block: false } },
    { verdict: 'refuse', input: { requestId: REQUEST_ID, reason: 'spam' } },
  ],
});

export const BANK_PERSONAL_REQUEST_SAFETY = defineProcedure({
  ...base,
  name: 'bank.personalRequest.safety',
  kind: 'query',
  path: 'personalRequest.safety',
  access: READ,
  refusals: refuse(...ONE_REQUEST),
  input: byId,
  output: personalRequestSafetySchema.nullable(),
  samples: [
    { verdict: 'accept', input: { requestId: REQUEST_ID } },
    { verdict: 'refuse', input: {} },
  ],
});

export const BANK_PERSONAL_REQUEST_PROCEDURES = [
  BANK_PERSONAL_REQUEST_CREATE,
  BANK_PERSONAL_REQUEST_LIST,
  BANK_PERSONAL_REQUEST_GET,
  BANK_PERSONAL_REQUEST_CANCEL,
  BANK_PERSONAL_REQUEST_DECLINE,
  BANK_PERSONAL_REQUEST_REMIND,
  BANK_PERSONAL_REQUEST_REMINDERS,
  BANK_PERSONAL_REQUEST_REPORT,
  BANK_PERSONAL_REQUEST_SAFETY,
] as const;
