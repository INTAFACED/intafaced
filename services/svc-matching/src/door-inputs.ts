import { z } from 'zod';
import {
  engineOrderTypeSchema,
  marketLifecycleAdmissionProofSchema,
  orderSideSchema,
  timeInForceSchema,
} from '@intafaced/exchange-contract';
import { RULEBOOK_SECTION_MAX } from './rulebook.js';

/**
 * The input each door of `router.ts` parses its body with, before it reaches the engine. Kept apart from the router so
 * `crates/svc-matching/scripts/record-door.mjs` can read them and the Rust door checks the same schemas. The submit
 * door's input is `MATCHING_SUBMIT_ORDER.input` (`@intafaced/exchange-contract`).
 */

/** Decimal string. Reusing the exchange contract's rule rather than inventing a second one. */
const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are positive decimal strings with at most 18 decimal places');
/** Offset may be negative. Still a decimal string — never a JSON number. */
const signedDecimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'offsets are signed decimal strings with at most 18 decimal places');

export const closePositionBodySchema = z.object({
  orderId: z.string().guid(),
  accountId: z.string().min(1).max(128),
  /** Same PLACE / market-lifecycle proof as a market submit. */
  lifecycleProof: marketLifecycleAdmissionProofSchema,
});

export const massCancelBodySchema = z.object({
  /** §5.1: account ids only. This service never learns whose account it is. */
  accountId: z.string().min(1).max(128),
  /** Not on the book. Present and non-empty refuses rather than inventing a session. */
  sessionId: z.string().max(128).nullish(),
  /** Present buy|sell is that side only (book + stops). Missing/null is both. */
  side: orderSideSchema.nullish(),
});

/**
 * MMP magnitudes on the wire. Decimal string or blank.
 * Blank is still MMP intent — unpublished refuse. Never a JSON number, never invented 0.
 */
const mmpMagnitude = z
  .string()
  .regex(/^(?:\d+(?:\.\d{1,18})?)?$/, 'MMP magnitudes are decimal strings or blank — never JSON numbers')
  .nullish();

export const mmpFieldsSchema = z.object({
  mmp: z.boolean().optional(),
  mmpMaxQuote: mmpMagnitude,
  mmpMaxPosition: mmpMagnitude,
  mmpMaxLoss: mmpMagnitude,
  mmpMaxDelta: mmpMagnitude,
  mmpMaxVega: mmpMagnitude,
  mmpVendor: z.boolean().optional(),
  sidecar: z.boolean().optional(),
});

export const quoteSideSchema = z
  .object({
    orderId: z.string().guid(),
    type: engineOrderTypeSchema,
    qty: decimal,
    price: decimal.nullish(),
    tif: timeInForceSchema,
  })
  .merge(mmpFieldsSchema);

export const massQuoteBodySchema = z
  .object({
    /** Quote set id. Empty refuses — the engine does not invent a set. */
    setId: z.string(),
    accountId: z.string().min(1).max(128),
    /** Explicit one-sided. Missing/false is a required two-sided pair (PTX-M11-R11). */
    oneSided: z.boolean().optional(),
    bid: quoteSideSchema.nullish(),
    ask: quoteSideSchema.nullish(),
    lifecycleProof: marketLifecycleAdmissionProofSchema,
  })
  .merge(mmpFieldsSchema);

export const venueKillBodySchema = z.object({
  operatorId: z.string().min(1).max(128),
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
});

export const sessionDeadBodySchema = z.object({
  /** Caller session. Missing/empty refuses — the engine does not invent a session. */
  sessionId: z.string().min(1).max(128),
});

export const amendBodySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    qty: decimal.optional(),
    price: decimal.optional(),
    stopPrice: decimal.optional(),
    tif: timeInForceSchema.optional(),
    lifecycleProof: marketLifecycleAdmissionProofSchema,
  })
  .superRefine((body, ctx) => {
    if (body.qty === undefined && body.price === undefined && body.stopPrice === undefined && body.tif === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amend must change qty, price, stopPrice, or tif' });
    }
  });

export const markBodySchema = z.object({ mark: decimal });

/**
 * Owner spread listing (CB-otc-16). Fields are strings or blank so a blank owner value reaches the typed refusal
 * instead of a generic 400. Consumed through the same dual-control approval as OPEN.
 */
export const spreadListBodySchema = z.object({
  kind: z.string().max(32).nullish(),
  legs: z
    .array(
      z.object({
        symbol: z.string().max(128).nullish(),
        side: z.string().max(8).nullish(),
        ratio: z.string().max(64).nullish(),
      }),
    )
    .max(8)
    .nullish(),
  tick: z.string().max(64).nullish(),
  lot: z.string().max(64).nullish(),
  operatorId: z.string().min(1).max(128),
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
});

/** A spread order. GTC limit at a signed spread price; the engine stamps the listing itself. */
export const spreadOrderBodySchema = z.object({
  orderId: z.string().guid(),
  accountId: z.string().min(1).max(128),
  side: orderSideSchema,
  qty: decimal,
  /** Spread price: a weighted leg-price difference, so it may be zero or negative. */
  price: signedDecimal,
  tif: timeInForceSchema,
  /** Caller reference for the anchor leg (leg 0). Missing refuses. The engine does not invent a mark. */
  anchorReference: decimal.nullish(),
  clientOrderId: z.string().min(1).max(128).optional(),
  environment: z.string().max(64).optional(),
  sessionId: z.string().max(128).optional(),
  lifecycleProof: marketLifecycleAdmissionProofSchema,
});

const counterpartOrderSchema = z.object({
  orderId: z.string().min(1).max(128),
  marketId: z.string().min(1).max(128),
  state: z.enum(['pending', 'open', 'terminal']),
  remaining: decimal,
  funded: z.boolean(),
  detail: z.string().max(256).optional(),
});

export const reconcileBodySchema = z.object({
  orders: z.array(counterpartOrderSchema).max(10_000),
});

/** The founder doors' body (`/operator/halt`, `/resume`, `/halt-all`, `/resume-all`). */
export const founderBody = z.object({
  marketId: z.string().min(1).max(64).optional(),
  approvalId: z.string().max(128),
  operationId: z.string().max(128),
  idempotencyKey: z.string(),
});

/** A rulebook draft (`/operator/rulebook/check`) and its publish (`/operator/rulebook/publish`). */
export const rulebookDraftBody = z.object({
  version: z.string().max(200).optional(),
  effectiveAt: z.string().max(64).optional(),
  sections: z.record(z.string(), z.string().max(RULEBOOK_SECTION_MAX * 2)).optional(),
});
export const rulebookPublishBody = rulebookDraftBody.extend({
  approvalId: z.string().max(128),
  operationId: z.string().max(128),
});
