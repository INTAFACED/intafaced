import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { actionApprovalFields, amountString, signedAmountString } from './bank-call-schemas.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `ops.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_OPS_ACCRUE_INTEREST = defineProcedure({
  ...base,
  name: 'bank.ops.accrueInterest',
  kind: 'mutation',
  path: 'ops.accrueInterest',
  access: { caller: 'service', callers: ['svc-bank'], forbidden: 'ops job is callable only as svc-bank' },
  refusals: {},
  input: z.object({ poolId: z.string().guid().optional(), at: z.string().datetime({ offset: true }).optional() }),
  output: z.object({
    results: z.array(
      z.object({
        poolId: z.string(),
        date: z.string(),
        paid: amountString,
        recipients: z.number().int(),
        alreadyAccrued: z.boolean(),
      }),
    ),
    /** Pools that threw (e.g. underfunded); day not consumed for those pools. */
    failures: z.array(
      z.object({
        poolId: z.string(),
        reason: z.string(),
        code: z.string().optional(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Give up on a pending loan and give the borrower their collateral back. */
export const BANK_OPS_ABANDON_PENDING_LOAN = defineProcedure({
  ...base,
  name: 'bank.ops.abandonPendingLoan',
  kind: 'mutation',
  path: 'ops.abandonPendingLoan',
  access: { caller: 'scope', scope: 'admin:treasury' },
  refusals: {},
  input: z.object({ loanId: z.string().guid(), ...actionApprovalFields }),
  output: z.object({
    released: amountString,
    ledgerTxId: z.string().nullable(),
    /** True when the draw had in fact booked: the loan was completed to active and no collateral moved. */
    adopted: z.boolean(),
    drawLedgerTxId: z.string().nullable(),
    confirmOperatorId: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { loanId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The reserve identity, as a query rather than an investigation:
 * `balance(loanReserve) + Σ outstanding principal` against what was funded.
 */
export const BANK_OPS_RECONCILE_LOAN_RESERVE = defineProcedure({
  ...base,
  name: 'bank.ops.reconcileLoanReserve',
  kind: 'query',
  path: 'ops.reconcileLoanReserve',
  access: { caller: 'scope', scope: 'admin:treasury' },
  refusals: {},
  input: z.object({ debtAssetId: z.string().min(1).max(16) }),
  output: z.object({
    reserveBalance: amountString,
    outstandingPrincipal: amountString,
    badDebt: amountString,
    funded: amountString,
    /** funded − badDebt − reserve − outstanding: a signed residual, negative when the reserve holds more than was recorded as funded. */
    drift: signedAmountString,
    /** False until funded is journal-independent; do not treat drift 0 as green. */
    independent: z.boolean(),
    insuranceCapacity: amountString,
  }),
  samples: [
    { verdict: 'accept', input: { debtAssetId: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const cardOutput = z.object({
  id: z.string(),
  /** Which balance the card draws on. Every posting against it is in this asset. */
  assetId: assetIdSchema,
  /**
   * What merchants charge this card in (§18).
   *
   * Equal to `assetId` means no conversion happens and no rate is consulted.
   * Different means every authorisation is quoted at the authorisation moment
   * — and refuses by name where no rate can be got, which on a fiat settlement
   * asset is every time, because this platform has no FX source.
   */
  settlementAssetId: z.string(),
  /** The programme id, which is also the ledger rail label. */
  issuer: z.string(),
  /** TRUE MEANS THERE IS NO CARD. Never omitted, never defaulted. */
  simulated: z.boolean(),
  /** Four digits. Not a card number and not part of one. */
  panTail: z.string(),
  /** `inactive`: issued but not activated yet (BK-cissue-04); it declines every authorisation until it is. */
  status: z.enum(['active', 'inactive', 'frozen', 'closed']),
  cashbackBps: z.number().int(),
  perAuthorizationLimit: amountString,
  dailyLimit: amountString.nullable(),
  monthlyLimit: amountString.nullable(),
  cashLimit: amountString.nullable(),
  online: z.boolean(),
  contactless: z.boolean(),
  atm: z.boolean(),
  abroad: z.boolean(),
  cardType: z.enum(['virtual', 'physical']),
  shippingAddress: z
    .object({
      name: z.string(),
      line1: z.string(),
      line2: z.string().nullable(),
      city: z.string(),
      region: z.string().nullable(),
      postalCode: z.string(),
      country: z.string(),
    })
    .nullable(),
  /** Single-use (1) or n-use: captured payments before it closes itself. NULL is no limit. */
  usesAllowed: z.number().int().nullable(),
  designId: z.string().nullable(),
  deliverySpeed: z.string().nullable(),
  replacesCardId: z.string().nullable(),
  replacedByCardId: z.string().nullable(),
});

/** The owner's card view without the shipping address. */
export const customerCardOutput = cardOutput.omit({ shippingAddress: true });

export const BANK_OPS_CUSTOMER_CARDS = defineProcedure({
  ...base,
  name: 'bank.ops.customerCards',
  kind: 'query',
  path: 'ops.customerCards',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z
    .object({
      userId: z.string().guid(),
      /** Page size. Optional so omit reaches `bank.cards_list_limit_unset` instead of a Zod "Required". Never defaulted. */
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  output: z.object({ userId: z.string(), cards: z.array(customerCardOutput) }),
  samples: [
    // The door refuses a read with no page size (`bank.cards_list_limit_unset`), so the accepted sample names one.
    { verdict: 'accept', input: { userId: '00000000-0000-4000-8000-000000000001', limit: 50 } },
    { verdict: 'refuse', input: 42 },
  ],
});
