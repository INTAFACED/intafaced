import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * AN ACCOUNT FREEZE ASKED FROM A REQUEST (J-support-public-20 #7, RC-support-public-07, RC-support-public-06).
 *
 * The desk asks, from a customer's request, that the customer's account be frozen. svc-identity records it: the
 * account's trading restriction (every fresh svc-trade operation, an order, a bot start or an agent's order, refuses
 * `trade.account_restricted` while it holds) and one audit row naming the request, the agent and the reason, in one
 * transaction. It then announces the freeze on the bus (`supportAccountFrozen`), so every service that keeps a
 * permission for an agent to act for the customer revokes it.
 *
 * Freezing only takes power away: no balance is read or kept, no ledger entry is posted, and the customer's own wallet
 * and venue account are not touched. Support has no door that lifts it, and a request's status change never reaches
 * svc-identity: only staff lift a trading restriction, through the founder controls' four-eyes restore. svc-support
 * keeps no copy and never says a freeze happened that svc-identity did not answer.
 *
 * Browser-safe: zod only at run time.
 */

const id = z.string().guid();
const at = z.string().datetime({ offset: true });
const reason = z.string().trim().min(1).max(500);

/** What svc-support asks svc-identity: the customer comes off the request, the agent is the signed principal. */
export const supportAccountFreezeInputSchema = z.object({ userId: id, ticketId: id, operatorId: id, reason }).strict();
export type SupportAccountFreezeInput = z.infer<typeof supportAccountFreezeInputSchema>;

/** svc-identity's record of the ask. */
export const supportAccountFreezeResultSchema = z
  .object({
    recordedBy: z.literal('svc-identity'),
    userId: id,
    /** The trading restriction as it stands after the ask: always true, since the answer comes only once it holds. */
    tradingRestricted: z.literal(true),
    /** False when the restriction already held and this request had already asked: nothing new was written. */
    changed: z.boolean(),
    /** The audit row that records this request's freeze. */
    auditId: id,
    recordedAt: at,
  })
  .strict();
export type SupportAccountFreezeResult = z.infer<typeof supportAccountFreezeResultSchema>;

/** One audit row of a request's freeze, as svc-identity keeps it. */
export const supportAccountFreezeRecordSchema = z
  .object({
    /** The audit row's id: the `auditId` its freeze answered. */
    id,
    ticketId: id,
    operatorId: id,
    reason,
    /** True when this ask set the restriction; false when one already held. */
    restrictionSet: z.boolean(),
    recordedAt: at,
  })
  .strict();
export type SupportAccountFreezeRecord = z.infer<typeof supportAccountFreezeRecordSchema>;

/** A request's audit rows, oldest first; at most 50, since one request asks once per restriction. */
export const supportAccountFreezeRecordsSchema = z
  .object({ recordedBy: z.literal('svc-identity'), records: z.array(supportAccountFreezeRecordSchema).max(50) })
  .strict();
export type SupportAccountFreezeRecords = z.infer<typeof supportAccountFreezeRecordsSchema>;

const TICKET = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';

/** The identity door's own `{ error, code }` refusals. */
const DOOR: Refusals = Object.freeze({
  'identity.unauthenticated': 'UNAUTHORIZED',
  'identity.support_freeze_forbidden': 'FORBIDDEN',
  'identity.support_freeze_input': 'BAD_REQUEST',
  'identity.account_not_found': 'NOT_FOUND',
  'identity.support_freeze_unavailable': 'SERVICE_UNAVAILABLE',
});

/**
 * svc-identity's signed door: freeze the request's customer's account. Only svc-support may call it, as a service, with
 * the body bound. Asking again from the same request while the restriction holds answers the first record.
 */
export const IDENTITY_SUPPORT_ACCOUNT_FREEZE = defineProcedure({
  name: 'identity.support.accountFreeze',
  service: 'svc-identity',
  transport: 'http',
  method: 'POST',
  path: '/internal/support/account-freeze',
  access: { caller: 'service', callers: ['svc-support'] },
  refusals: DOOR,
  input: supportAccountFreezeInputSchema,
  output: supportAccountFreezeResultSchema,
  samples: [
    { verdict: 'accept', input: { userId: USER, ticketId: TICKET, operatorId: AGENT, reason: 'TEST account taken over' } },
    { verdict: 'refuse', input: { userId: USER, ticketId: TICKET, operatorId: AGENT, reason: '' } },
  ],
});

/** svc-identity's signed door: the audit rows one request's freezes wrote for its customer. It reads; it never writes. */
export const IDENTITY_SUPPORT_ACCOUNT_FREEZE_RECORDS = defineProcedure({
  name: 'identity.support.accountFreezeRecords',
  service: 'svc-identity',
  transport: 'http',
  method: 'POST',
  path: '/internal/support/account-freeze/records',
  access: { caller: 'service', callers: ['svc-support'] },
  refusals: DOOR,
  input: z.object({ userId: id, ticketId: id }).strict(),
  output: supportAccountFreezeRecordsSchema,
  samples: [
    { verdict: 'accept', input: { userId: USER, ticketId: TICKET } },
    { verdict: 'refuse', input: { userId: USER } },
  ],
});

const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;
const DESK = { caller: 'scope', scope: 'support:ops' } as const;

/** The desk's refusal when svc-identity gave no answer: nothing is claimed. */
export const SUPPORT_ACCOUNT_FREEZE_UNAVAILABLE = 'support.account_freeze_unavailable' as const;

/**
 * The desk asks, from a request, that its customer's account be frozen. The customer comes off the request, never from
 * the agent's input. A closed request takes no freeze; a request outside the desk's scope answers as not found.
 */
export const SUPPORT_REQUEST_ACCOUNT_FREEZE = defineProcedure({
  ...base,
  name: 'support.requestAccountFreeze',
  kind: 'mutation',
  path: 'requestAccountFreeze',
  access: DESK,
  refusals: Object.freeze({
    'support.not_found': 'NOT_FOUND',
    'support.ticket_closed': 'PRECONDITION_FAILED',
    [SUPPORT_ACCOUNT_FREEZE_UNAVAILABLE]: 'PRECONDITION_FAILED',
  }),
  input: z.object({ ticketId: id, reason }).strict(),
  output: supportAccountFreezeResultSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, reason: 'TEST account taken over' } },
    { verdict: 'refuse', input: { ticketId: TICKET, reason: 'TEST', userId: USER } },
  ],
});

/** The desk reads back, from svc-identity, what was recorded for one request's account freezes. */
export const SUPPORT_ACCOUNT_FREEZE_RECORDS = defineProcedure({
  ...base,
  name: 'support.accountFreezeRecords',
  kind: 'query',
  path: 'accountFreezeRecords',
  access: DESK,
  refusals: Object.freeze({ 'support.not_found': 'NOT_FOUND', [SUPPORT_ACCOUNT_FREEZE_UNAVAILABLE]: 'PRECONDITION_FAILED' }),
  input: z.object({ ticketId: id }).strict(),
  output: supportAccountFreezeRecordsSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET } },
    { verdict: 'refuse', input: { ticketId: TICKET, userId: USER } },
  ],
});
