import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';
import { SUPPORT_DISCLOSURE_KINDS } from './support-verification-checks.js';

/**
 * A customer's grant for support to read (J-support-public-20 #2, RC-support-public-01; owner row d115, 17 Nov 2026:
 * balances and withdrawal details only with the customer's permission for a set time, every read listed where the
 * customer sees it).
 *
 * The desk may not read a customer's balance or withdrawal destination from a request until the customer, signed in
 * and on their own request, grants support a read for a length of time they choose. The grant is on that one request
 * and ends by itself; a new grant replaces the one before it, so a customer shortens a grant by granting again. Each
 * read the desk is answered is one row the customer reads on the same request: what was read, who read it, and when.
 * A read that cannot be listed is not answered.
 *
 * The figures come from the service that owns them, asked by svc-support as a service for the request's own customer:
 * the balance from svc-trade (the same figures the customer's own balance read gives), the destination of each
 * withdrawal linked to the request from svc-pay. svc-support stores neither.
 *
 * Browser-safe: zod only at run time.
 */

/** The shortest and the longest grant a customer can give, in seconds (half a minute; one week). Bounds on the input. */
export const SUPPORT_READ_GRANT_MIN_SECONDS = 30;
export const SUPPORT_READ_GRANT_MAX_SECONDS = 604_800;
/** How many reads one request lists to its customer, newest first. A bound on the answer, not an owner value. */
export const SUPPORT_READ_LIST_MAX = 200;
/** How many linked withdrawals one destination read covers. */
export const SUPPORT_READ_DESTINATIONS_MAX = 50;

const ticketId = z.string().guid();
const at = z.string().datetime({ offset: true });

export const supportGrantReadInputSchema = z
  .object({
    ticketId,
    seconds: z.number().int().min(SUPPORT_READ_GRANT_MIN_SECONDS).max(SUPPORT_READ_GRANT_MAX_SECONDS),
  })
  .strict();
export type SupportGrantReadInput = z.infer<typeof supportGrantReadInputSchema>;

/** One grant: the request it is on, when the customer gave it and when it ends. */
export const supportReadGrantSchema = z
  .object({
    ticketId,
    grantedAt: at,
    expiresAt: at,
    /** Whether it still holds, on the service's clock when it answered. */
    active: z.boolean(),
  })
  .strict();
export type SupportReadGrant = z.infer<typeof supportReadGrantSchema>;

/** One read the desk was answered under a grant. No figure is kept: what was read, by whom, and when. */
export const supportReadRowSchema = z
  .object({
    kind: z.enum(SUPPORT_DISCLOSURE_KINDS),
    /** The support agent who read it. */
    readBy: z.string().min(1).max(128),
    readAt: at,
  })
  .strict();
export type SupportReadRow = z.infer<typeof supportReadRowSchema>;

/** The customer's view of one request's support access: the newest grant (null when none was given) and every read. */
export const supportReadAccessSchema = z
  .object({
    ticketId,
    grant: supportReadGrantSchema.nullable(),
    /** Newest first, at most `SUPPORT_READ_LIST_MAX`. */
    reads: z.array(supportReadRowSchema).max(SUPPORT_READ_LIST_MAX),
  })
  .strict();
export type SupportReadAccess = z.infer<typeof supportReadAccessSchema>;

/** A non-negative decimal string, at most 18 places. A JSON number is refused: money is never a number. */
const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are decimal strings with at most 18 decimal places');
const assetBalance = z.object({ free: amount, used: amount, total: amount }).strict();
/** A balance by asset, as the customer's own balance read gives it. */
export const supportCustomerBalancesSchema = z.record(z.string().min(1).max(32), assetBalance);
export type SupportCustomerBalances = z.infer<typeof supportCustomerBalancesSchema>;

/** Where one withdrawal goes, as svc-pay holds it. */
export const supportWithdrawalDestinationSchema = z
  .object({
    withdrawalId: z.string().guid(),
    destination: z.object({ kind: z.string().min(1).max(64), ref: z.string().min(1).max(512) }).strict(),
  })
  .strict();
export type SupportWithdrawalDestination = z.infer<typeof supportWithdrawalDestinationSchema>;

/** What the desk is answered under a live grant: the read, when it was made and when the grant ends. */
export const supportDisclosureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('balance'), readAt: at, grantExpiresAt: at, balances: supportCustomerBalancesSchema }).strict(),
  z
    .object({
      kind: z.literal('destination'),
      readAt: at,
      grantExpiresAt: at,
      withdrawals: z.array(supportWithdrawalDestinationSchema).max(SUPPORT_READ_DESTINATIONS_MAX),
    })
    .strict(),
]);
export type SupportDisclosure = z.infer<typeof supportDisclosureSchema>;

const TICKET = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;
const OWN: Refusals = Object.freeze({ 'support.not_found': 'NOT_FOUND', 'support.ticket_closed': 'PRECONDITION_FAILED' });

/** The customer grants support a read on their own request, for the seconds they choose. Not theirs: `support.not_found`. */
export const SUPPORT_GRANT_READ = defineProcedure({
  ...base,
  name: 'support.grantRead',
  kind: 'mutation',
  path: 'grantRead',
  access: { caller: 'scope', scope: 'support:write' },
  refusals: OWN,
  input: supportGrantReadInputSchema,
  output: supportReadGrantSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, seconds: 600 } },
    { verdict: 'refuse', input: { ticketId: TICKET, seconds: 5 } },
    { verdict: 'refuse', input: { ticketId: TICKET, seconds: 600, userId: USER } },
  ],
});

/** The customer reads their request's support access: the newest grant and each read the desk was answered. */
export const SUPPORT_READ_ACCESS = defineProcedure({
  ...base,
  name: 'support.readAccess',
  kind: 'query',
  path: 'readAccess',
  access: { caller: 'scope', scope: 'support:read' },
  refusals: Object.freeze({ 'support.not_found': 'NOT_FOUND' }),
  input: z.object({ ticketId }).strict(),
  output: supportReadAccessSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET } },
    { verdict: 'refuse', input: { ticketId: TICKET, userId: USER } },
  ],
});

/** The door's own `{ error, code }` refusals, shared by both owners' doors. */
const doorRefusals = (service: 'trade' | 'pay'): Refusals =>
  Object.freeze({
    [`${service}.unauthenticated`]: 'UNAUTHORIZED',
    [`${service}.support_read_forbidden`]: 'FORBIDDEN',
    [`${service}.support_read_input`]: 'BAD_REQUEST',
    [`${service}.support_read_unavailable`]: 'SERVICE_UNAVAILABLE',
  });

/**
 * svc-trade's signed door: one customer's balance by asset, the same figures their own balance read gives. Only
 * svc-support may call it, as a service, and only for the customer of a request that holds a live grant (svc-support
 * checks the grant before it calls; svc-trade cannot read the support tables). Read-only: no recipe, no post.
 */
export const SUPPORT_CUSTOMER_BALANCE_READ = defineProcedure({
  name: 'trade.support.customerBalance',
  service: 'svc-trade',
  transport: 'http',
  method: 'POST',
  path: '/internal/support/customer-balance',
  access: { caller: 'service', callers: ['svc-support'] },
  refusals: doorRefusals('trade'),
  input: z.object({ userId: z.string().guid() }).strict(),
  output: z.object({ balances: supportCustomerBalancesSchema }).strict(),
  samples: [
    { verdict: 'accept', input: { userId: USER } },
    { verdict: 'refuse', input: { userId: 'someone' } },
  ],
});

/**
 * svc-pay's signed door: where each of these withdrawals goes, for the withdrawals that are this customer's. An id that
 * is missing or another customer's is left out, the same way, so the door tells nobody whether an id exists or whose it
 * is. Only svc-support may call it, as a service. It reads; it never writes.
 */
export const SUPPORT_WITHDRAWAL_DESTINATIONS_READ = defineProcedure({
  name: 'pay.support.withdrawalDestinations',
  service: 'svc-pay',
  transport: 'http',
  method: 'POST',
  path: '/internal/support/withdrawal-destinations',
  access: { caller: 'service', callers: ['svc-support'] },
  refusals: doorRefusals('pay'),
  input: z
    .object({
      userId: z.string().min(1).max(128),
      withdrawalIds: z.array(z.string().guid()).min(1).max(SUPPORT_READ_DESTINATIONS_MAX),
    })
    .strict(),
  output: z.object({ withdrawals: z.array(supportWithdrawalDestinationSchema).max(SUPPORT_READ_DESTINATIONS_MAX) }).strict(),
  samples: [
    { verdict: 'accept', input: { userId: USER, withdrawalIds: [TICKET] } },
    { verdict: 'refuse', input: { userId: USER, withdrawalIds: [] } },
  ],
});
