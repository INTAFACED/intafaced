import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `directDebits.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const mandateId = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

/**
 * `bank.directDebits.*` (BK-xfer-11, J-bank-06 #4): the person's Direct Debit mandates. Reads are `bank:read`; block,
 * unblock and a refund request are `bank:write`. Support's refund queue is `admin:read`. Setting a mandate up and
 * presenting a collection are the scheme speaking: they are signed job doors (`/internal/jobs/dd-sim/*`), never here.
 */
export const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

export const DD_COLLECTION_STATUSES = ['upcoming', 'processing', 'collected', 'failed', 'rejected'] as const;

/** A failed collection's fee: the owner has no failure fee table, so it is not set and nothing is charged. */
export const DD_FAILURE_FEE_UNSET = 'bank.dd_failure_fee_unset';

export const collectionView = z.object({
  id: z.string(),
  mandateId: z.string(),
  collectionId: z.string(),
  creditorName: z.string(),
  assetId: z.string(),
  amount: amountString,
  dueAt: z.string(),
  status: z.enum(DD_COLLECTION_STATUSES),
  failureCode: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  /** The partner's reference for the move that collected it, when the partner bank holds the money (OWNER 226). */
  partnerMoveId: z.string().nullable(),
  presentedAt: z.string(),
  settledAt: z.string().nullable(),
  failureFee: z.null(),
  failureFeeBlocker: z.literal(DD_FAILURE_FEE_UNSET).nullable(),
  refund: z.object({
    state: z.enum(['none', 'available', 'requested', 'closed', 'unset']),
    endsAt: z.string().nullable(),
    requestedAt: z.string().nullable(),
  }),
});

export const mandateView = z.object({
  id: z.string(),
  creditorId: z.string(),
  creditorName: z.string(),
  reference: z.string(),
  assetId: z.string(),
  status: z.enum(['active', 'blocked']),
  blockedAt: z.string().nullable(),
  createdAt: z.string(),
  upcoming: z.array(collectionView),
});

export const BANK_DIRECT_DEBITS_BLOCK = defineProcedure({
  ...base,
  name: 'bank.directDebits.block',
  kind: 'mutation',
  path: 'directDebits.block',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ mandateId }).strict(),
  output: z.object({
    mandate: mandateView,
    rejected: z.array(z.string()),
    tooLate: z.array(z.object({ collectionId: z.string(), code: z.literal('bank.dd_too_late') })),
    /** The partner the block was sent to, when it holds the money; null on the custodial layer. */
    sentTo: z.string().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { mandateId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_DIRECT_DEBITS_UNBLOCK = defineProcedure({
  ...base,
  name: 'bank.directDebits.unblock',
  kind: 'mutation',
  path: 'directDebits.unblock',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ mandateId }).strict(),
  output: z.object({ mandate: mandateView }),
  samples: [
    { verdict: 'accept', input: { mandateId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_DIRECT_DEBITS_REQUEST_REFUND = defineProcedure({
  ...base,
  name: 'bank.directDebits.requestRefund',
  kind: 'mutation',
  path: 'directDebits.requestRefund',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ collectionId: z.string().uuid(), reason: z.string().min(1).max(500) }).strict(),
  output: z.object({ collection: collectionView, created: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { collectionId: '11111111-1111-4111-8111-111111111111', reason: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_DIRECT_DEBITS_LIST = defineProcedure({
  ...base,
  name: 'bank.directDebits.list',
  kind: 'query',
  path: 'directDebits.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    scheme: z.object({
      status: z.enum(['unset', 'live']),
      standIn: z.string().nullable(),
      guaranteeDays: z.number().int().nullable(),
      blocker: z.literal('rail.bank').nullable(),
    }),
    mandates: z.array(mandateView),
    collections: z.array(collectionView),
  }),
  samples: [{ verdict: 'accept' }],
});
