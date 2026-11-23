import { z } from 'zod';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-token's records share, moved from the service so the records and every caller read one copy. */

export const launchId = z.string().min(3).max(63);

export const ISSUER_STATES = ['applied', 'reviewing', 'onboarded', 'suspended'] as const;

/**
 * Token launch events (J-more-catalogue-11): the catalogue, one event with its periods, issuer state, allocation rule
 * and terms, and the holdings snapshot an allocation by holdings is based on.
 *
 * Nothing here moves value. Allocation and distribution would move tokens, and no ledger recipe is wired for them, so
 * an event stops at `closed` and the next move refuses `launch.allocation_unwired`. A snapshot row is a measurement of
 * active stake taken in the move to `snapshot`, never a claim on anything.
 *
 * A blank price, cap, ticket size or weight stays null and the reader shows "not set". Nothing is defaulted.
 */
export const LAUNCH_TYPES = ['token_sale', 'whitelist_drop', 'primary_subscription'] as const;

export const LAUNCH_STATUSES = [
  'draft',
  'announced',
  'snapshot',
  'open',
  'closed',
  'allocated',
  'distributing',
  'complete',
  'cancelled',
] as const;

export const LAUNCH_STATES = ['upcoming', 'open', 'past'] as const;

export const ALLOCATION_METHODS = ['pro_rata', 'tickets', 'tiered'] as const;

export const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');

export const eventOutput = z.object({
  id: z.string(),
  issuer: z.object({ id: z.string(), name: z.string(), state: z.enum(ISSUER_STATES) }),
  type: z.enum(LAUNCH_TYPES),
  projectName: z.string(),
  symbol: z.string(),
  periods: z.object({
    announceAt: z.string(),
    snapshotAt: z.string(),
    openAt: z.string(),
    closeAt: z.string(),
    distributionAt: z.string(),
  }),
  status: z.enum(LAUNCH_STATUSES),
  state: z.enum(LAUNCH_STATES).nullable(),
  allocation: z.object({
    method: z.enum(ALLOCATION_METHODS).nullable(),
    perUserCap: amountString.nullable(),
    ticketSize: amountString.nullable(),
    tierWeights: z.array(z.object({ minBasis: amountString, weight: z.number().int() })).nullable(),
  }),
  terms: z.object({ price: amountString.nullable(), paymentAsset: z.string().nullable(), rateSource: z.string().nullable() }),
  snapshot: z.object({ count: z.number().int(), total: amountString, takenAt: z.string() }).nullable(),
  revision: z.number().int(),
});

export const approvalFields = { approvalId: z.string().max(128).nullish(), operationId: z.string().max(128).nullish() };

export const iso = z.string().datetime({ offset: true });

export const createInput = z.object({
  id: launchId,
  issuerId: launchId,
  type: z.enum(LAUNCH_TYPES),
  projectName: z.string().min(1).max(120),
  symbol: z.string().min(2).max(12),
  periods: z.object({ announceAt: iso, snapshotAt: iso, openAt: iso, closeAt: iso, distributionAt: iso }).strict(),
  allocation: z
    .object({
      method: z.enum(ALLOCATION_METHODS).nullable(),
      perUserCap: amountString.nullable(),
      ticketSize: amountString.nullable(),
      tierWeights: z
        .array(z.object({ minBasis: amountString, weight: z.number().int() }).strict())
        .max(16)
        .nullable(),
    })
    .strict(),
  terms: z
    .object({ price: amountString.nullable(), paymentAsset: z.string().max(12).nullable(), rateSource: z.string().max(120).nullable() })
    .strict(),
});
