import { z } from 'zod';
import { payPricingSnapshotViewSchema, payMerchantFailureSchema } from './pay-merchant-reads.js';
import { assetIdSchema as brandedAssetIdSchema } from './asset-id.js';
import { payAmountStringSchema, payMerchantIdSchema, payAssetCodeSchema, payReasonSchema } from './merchant-control.js';
import { PAY_TRAVEL_RULE_FIELDS, PAY_DEPOSIT_TRAVEL_RULE_STATES, PAY_DEPOSIT_WALLET_TYPES } from './pay-custody-deposit.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-pay's records share, moved from the service so the records and every caller read one copy. */

export const assetIdSchema = z.string().min(1).max(16);

/**
 * svc-pay's internal tRPC surface (§2 — cross-service calls go through
 * packages/contracts).
 *
 * MONEY CROSSES THIS BOUNDARY AS A DECIMAL STRING, always, in both directions.
 * `amountSchema` rejects anything else, including a JSON number, so a caller
 * that has been doing float arithmetic finds out here rather than 18 decimal
 * places later.
 *
 * Every procedure that moves value carries a scope AND the jurisdiction guard
 * (`{ module: 'pay' }`). §22: pay is a custodial Fiat Plane module — value
 * lands in a ledger account we control — so the matrix applies. Lane A
 * (permissionless merchant contracts, §24) is a different service on the
 * Protocol Plane and does not route through here.
 */
export const amountSchema = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');

export const depositView = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  assetId: assetIdSchema,
  amount: amountSchema,
  rail: z.string(),
  railRef: z.string(),
  status: z.enum(['pending', 'credited']),
  createdAt: z.string().datetime({ offset: true }),
});

export const paymentView = z.object({
  id: z.string().guid(),
  merchantId: z.string().guid(),
  profileId: z.string().guid().nullable(),
  amount: amountSchema,
  assetId: assetIdSchema,
  method: z.string(),
  railAdapter: z.string(),
  railRef: z.string().nullable(),
  status: z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']),
  capturedAmount: amountSchema,
  refundedAmount: amountSchema,
  createdAt: z.string().datetime({ offset: true }),
  /** Stored when the fee was decided. Null when no snapshot row exists. Never recomputed. */
  pricingSnapshot: payPricingSnapshotViewSchema.nullable(),
  /** Catalog code and sentence. Null when the payment has not failed. */
  failure: payMerchantFailureSchema.nullable(),
});

export const limit = z.number().int().min(1).max(200);

export const id = z.string().guid();

/** `limit` is optional here so an omitted bound reaches `withdrawal_approval.list_limit_unset` and not a parse error. */
export const listInputSchema = z.object({ limit: limit.optional(), after: id.optional() }).strict();

export const APPROVAL_STATUSES = ['pending', 'approved', 'executed', 'rejected', 'expired', 'canceled', 'failed'] as const;

export const requestViewSchema = z.object({
  id,
  userId: id,
  assetId: brandedAssetIdSchema,
  amount: z.string(),
  rail: z.string(),
  destination: z.object({ kind: z.string(), ref: z.string() }),
  clientRef: z.string(),
  teamAccountId: id,
  requiredApprovals: z.number().int(),
  approvalCount: z.number().int(),
  /** Whether the viewer already approved. A viewer who is not the initiator never sees who else did. */
  approvedByMe: z.boolean(),
  holdAtSubmit: z.boolean(),
  status: z.enum(APPROVAL_STATUSES),
  failureCode: z.string().nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
});

export const getInputSchema = z.object({ requestId: id }).strict();

export const decideInputSchema = z.object({ requestId: id }).strict();

/**
 * A checkout session on the wire.
 *
 * NOTHING HERE IDENTIFIES ANYTHING BUT THIS SESSION. No merchantId, no linkId,
 * no paymentId, no railAdapter — the caller is anonymous, so the response
 * carries what one payer needs in order to pay and nothing they could use to
 * enumerate a merchant or correlate two links.
 */
export const checkoutSessionView = z.object({
  id: z.string().guid(),
  status: z.enum(['open', 'completed', 'expired', 'cancelled']),
  label: z.string(),
  amount: amountSchema,
  currency: assetIdSchema,
  method: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
  instruction: z.object({ reference: z.string(), amount: amountSchema, currency: assetIdSchema }).nullable(),
  /** RC-merchant-09: the bank transfer arrived and is held for a payer-name review; nothing more should be sent. */
  heldForReview: z.boolean().optional(),
});

/**
 * §6.1: `capabilities: RailCapability[]`.
 *
 * THE FIRST FIVE ARE THE ORIGINAL PORT and every registered adapter declares
 * some subset of them. The rest were added when the ADR of 2026-08-04
 * (`docs/adr/2026-08-04-pay-rails-and-psp-socket.md`) established that the port
 * could not express what a card rail does: *"Ours knows authorized | captured |
 * refunded | failed | payout.completed. A card rail needs partial capture, void,
 * 3DS/SCA next-action, disputes, mandates and FX."*
 *
 * ADDING A MEMBER HERE IS NOT ADDING A FEATURE. It is adding a QUESTION the core
 * is allowed to ask an adapter, and the only two honest answers are "yes, and
 * here is the method" and a refusal that names the rail and the operation. There
 * is deliberately no third answer, because the third answer is the one where a
 * rail returns a plausible result for an operation it never performed — see
 * `RailOperationUnsupportedError`.
 *
 * `crypto-native` and `card-sandbox` declare exactly what they declared before
 * this list grew. A capability an adapter does not name is one the core refuses
 * to route to it, so growth here cannot silently change either of them.
 */
export const RAIL_CAPABILITIES = [
  'authorize',
  'capture',
  'refund',
  'payout',
  'webhook',
  /** Capture LESS than was authorised, leaving the remainder to void or expire. */
  'capture.partial',
  /** Release an authorization without ever taking the money. */
  'void',
  /** Report and contest chargebacks. A rail without this cannot be disputed against. */
  'dispute',
  /** Store a payer's agreement to be charged again later (SEPA DD, card-on-file). */
  'mandate',
  /** Quote and settle across currencies at the rail boundary. */
  'fx',
] as const;

/**
 * WHETHER THIS RAIL MOVES REAL MONEY. The most important field on the interface.
 *
 *   live    — a real counterparty is at the other end. A `paid_out` result means
 *             funds actually left, and the `railRef` names a movement somebody
 *             outside this company can be asked about.
 *   sandbox — the counterparty is simulated. Everything on this side of the
 *             interface is real, and NOTHING on the other side is. It SUCCEEDS.
 *   absent  — nothing is behind this rail at all. Every call refuses. The rail is
 *             registered so the core can name it and say why it cannot be used.
 *
 * ── WHY THERE ARE THREE, AND WHY THERE USED TO BE TWO ────────────────────────
 *
 * `ChainPosture` in `chain-port.ts` has had three values from the start, and its
 * comment says why: *"a sandbox succeeds and an absent chain must refuse."*
 * `RailMode` had two, and `crypto-native` collapsed the third into `sandbox`:
 *
 *     this.mode = chain.posture === 'live' ? 'live' : 'sandbox';
 *
 * So a rail that was MISSING and a rail that was DELIBERATELY SIMULATED reported
 * the same thing — and the collapse ran in the unsafe direction, because absence
 * read as a working sandbox. The ADR of 2026-08-04 names this a defect and
 * requires the distinction: *"Make `RailMode` carry `absent` distinctly, or state
 * in the type why it may not."* This is it carrying it.
 *
 * ── WHAT THE COLLAPSE ACTUALLY COST, CONCRETELY ──────────────────────────────
 *
 * It was not only a reporting blur. `defaultChainFor` gives `staging`/`prod` an
 * `UnconfiguredChain` when nothing is configured — that is the DESIGNED
 * production default, and it is the safe one. Under the collapse that chain made
 * `crypto-native` report `sandbox`, `assertRailPosture` counted it as a sandbox
 * rail, and the process REFUSED TO BOOT. The only way out was
 * `PAY_ALLOW_SANDBOX_RAILS=true` — the flag whose whole meaning is "sandbox rails
 * may move value here". The collapse therefore manufactured pressure to set, in
 * production, the exact override it exists to warn about, in order to start a
 * service that had no chain to abuse in the first place.
 *
 * With `absent` distinct, an unconfigured production deployment boots, every
 * crypto call refuses by name with `chain.not_configured`, and the override stays
 * unset and meaningful.
 *
 * ── THE PROPERTY THAT MUST SURVIVE EVERY FUTURE EDIT ─────────────────────────
 *
 * SANDBOX IS NEVER REPORTABLE AS LIVE, BY ANY COLLAPSE, AT ANY LAYER. Widening
 * this type does not touch that: `isLive` is `mode === 'live'` and nothing else,
 * and every posture gate in `posture.ts` lets only `'live'` through and refuses
 * everything else. A member added here is refused by default; it could only ever
 * become permissive by someone editing `isLive`, which is one line, reviewed on
 * its own, and asserted against in `rail-adapter.widening.test.ts`.
 *
 * WHY IT IS ON THE INTERFACE AND NOT IN A CONFIG FILE. An adapter is the only
 * thing that knows whether it has a counterparty; a deployment list of "which
 * rails are real" is a second copy of that fact, and the copy is what goes stale.
 * `card-sandbox` is `sandbox` by construction and cannot be configured otherwise.
 * `crypto-native` is `live` exactly when the chain behind it is live, and it
 * derives its own answer rather than being told.
 *
 * WHAT IT PREVENTS. A withdrawal settled against a sandbox rail debits the user's
 * real ledger balance, returns a fabricated provider reference, and reports
 * `sent`. The user has been told their money moved. There is no worse bug
 * available in this service, and it is not detectable after the fact — the books
 * balance perfectly, because the only thing missing is the money. `posture.ts`
 * is what refuses it; this field is what makes the refusal possible.
 */
export const RAIL_MODES = ['live', 'sandbox', 'absent'] as const;

export const subMerchantView = z.object({
  id: z.string().guid(),
  userId: z.string(),
  parentMerchantId: z.string().guid().nullable(),
  mode: z.enum(['gateway', 'psp', 'payfac']),
  status: z.enum(['pending', 'active', 'suspended', 'closed']),
  kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
  settlingParty: z.string(),
  /**
   * Nullable, and NOT defaulted to zero. A sub-merchant onboarded by some other
   * path may carry no `feeBps`, and rendering that as `0` would tell an operator
   * the merchant is processed free of charge. `settleWindow` already refuses to
   * settle rather than assume a rate; a read surface must not assume one either.
   */
  feeBps: z.number().int().nullable(),
  depth: z.number().int(),
  createdAt: z.string().datetime({ offset: true }),
});

/**
 * THE PERMISSION AREAS.
 *
 * Each one names a surface `services/svc-pay` genuinely has today. Read the
 * banner above before adding one: the number in the tracker title is not a
 * target, and an area that names nothing is worse than a missing area, because
 * it can be granted and then does nothing.
 */
export const PERMISSION_AREAS = [
  /** The sub-merchant's own record: pricing band, settlement prefs, status. */
  'merchant.profile',
  /** `payment_profiles` — checkout config, fee routing, allowed domains. */
  'checkout.profile',
  /** `payment_links` — shareable links and their use counters. */
  'payment.link',
  /** Create and read payments. NOT refunds — sending money back is its own area. */
  'payment',
  /** Refund a captured payment. Separate because it moves value back out. */
  'payment.refund',
  /** Read and run settlement windows. */
  'settlement',
  /** Pay a settlement out through a rail. The value-leaves-the-platform area. */
  'settlement.payout',
  /** Outbound webhook endpoints and the delivery dashboard. */
  'webhook',
  /** Submit and read the KYB dossier state. */
  'kyb',
  /** See and onboard nodes beneath this one. */
  'submerchant',
  /** Grant and revoke within this subtree. Delegating delegation. */
  'permission',
] as const;

/**
 * THE PAYFAC SURFACE (§6.1) — sub-merchant trees and the permissions over them.
 *
 * ══ AUTHORIZATION IS ENFORCED HERE, NOT DOCUMENTED HERE ══════════════════════
 *
 * Every procedure below does the same three things in the same order, and none
 * of them is optional:
 *
 *   1. `scopedProcedure(…, { module: 'pay' })` — the caller holds a pay scope and
 *      passes the §22 jurisdiction matrix, exactly like every other procedure in
 *      this service.
 *   2. `actor()` — the caller's OWN merchant node, resolved from the
 *      authenticated principal. There is no `actorMerchantId` on the wire, so
 *      there is nothing to forge; a caller who is not a merchant is refused
 *      before any tree is walked.
 *   3. The service's subtree fence and permission check, which throw
 *      `pay.merchant_not_found` (outside the tree reads exactly like a missing
 *      id) / `pay.submerchant_permission_denied` (inside the tree, no grant).
 *
 * Step 2 is the one that would be easy to get wrong. `pay:write` is a MERCHANT'S
 * scope, held by every merchant on the platform — so if the merchant node came
 * from the request body, any merchant could name any other merchant as the node
 * they were "acting as" and the tree fence would be measuring the wrong actor
 * entirely. The scope says what kind of caller this is; the tree says what they
 * can reach; and only the principal decides which node they are.
 *
 * ══ WHY ITS OWN ROUTER FILE ══════════════════════════════════════════════════
 *
 * Merged into the pay router with `mergeRouters` in `index.ts`, the same way
 * `merchant-state-router.ts` is, so there is still one wire surface and the edge
 * still forwards `/api/pay` to a single router. `router.ts` is already a
 * thousand lines covering the gateway surface; the payfac surface has a
 * different reader and a different authorization model, and keeping it separate
 * is what stops the second from being read as a footnote to the first.
 */
export const areaSchema = z.enum(PERMISSION_AREAS);

export const grantView = z.object({
  granteeMerchantId: z.string().guid(),
  subjectMerchantId: z.string().guid(),
  area: areaSchema,
  reason: z.string(),
  actorId: z.string(),
  actorMerchantId: z.string().guid(),
  grantedAt: z.string().datetime({ offset: true }),
});

export const permissionEventView = z.object({
  id: z.string().guid(),
  /** A `bigserial` ordering key. A string, never arithmetic. */
  seq: z.string(),
  granteeMerchantId: z.string().guid(),
  subjectMerchantId: z.string().guid(),
  area: z.string(),
  action: z.enum(['grant', 'revoke']),
  reason: z.string(),
  actorId: z.string(),
  actorMerchantId: z.string().guid(),
  actorScope: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});

/** One row of `fraud.listOpenReviews`: an open or claimed case, with the rules that sent it to review. */
export const fraudReviewRowSchema = z
  .object({
    id: z.string().min(1),
    merchantId: z.string().min(1),
    paymentId: z.string().nullable(),
    paymentRef: z.string().nullable(),
    amount: z.string(),
    assetId: brandedAssetIdSchema.min(1),
    status: z.enum(['open', 'claimed', 'allowed', 'declined']),
    reason: z.string(),
    createdAt: z.string().min(1),
    reasons: z.array(z.object({ ruleId: z.string(), detail: z.string() }).strict()),
  })
  .strict();

/**
 * Highest merchant fee rate svc-pay accepts, in basis points.
 *
 * 10000 bps is a 100% fee: every settlement window then nets to zero and refuses with
 * `pay.fee_exceeds_gross`, so the merchant's money would sit in clearing forever. A rate
 * the settlement cannot use is refused where it is set. svc-p2p's bound is 9999 for the
 * same reason (a release must leave the buyer something).
 */
export const MAX_FEE_BPS = 9_999;

export const summaryPayment = z
  .object({
    id: z.string().guid(),
    status: z.string(),
    amount: payAmountStringSchema,
    assetId: brandedAssetIdSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const subMerchantSummaryView = subMerchantView
  .extend({
    displayName: z.string().nullable(),
    legalName: z.string().nullable(),
    /** Null when the caller does not hold `payment`. Empty items means none in the window. */
    volume: z
      .object({
        window: z.object({ kind: z.literal('preset'), preset: z.literal('rolling_30d') }).strict(),
        items: z.array(
          z
            .object({
              assetCode: z.string(),
              volume: payAmountStringSchema,
              count: z.number().int().min(0),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    recentPayments: z
      .object({
        items: z.array(summaryPayment),
        nextCursor: z.string().nullable(),
      })
      .strict()
      .nullable(),
    /** Null when the caller does not hold `permission`. Implicit root authority is not listed. */
    grants: z
      .object({
        items: z.array(
          z
            .object({
              area: z.string(),
              granteeMerchantId: z.string().guid(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const usageInputSchema = z.object({ merchantId: payMerchantIdSchema }).strict();

export const pricingPreviewInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    assetCode: payAssetCodeSchema,
    amount: payAmountStringSchema,
    /** Volume already done this month, to pick the band. Omit to use the merchant's real month-to-date. */
    monthlyVolume: payAmountStringSchema.optional(),
    /** USD to USDT conversion: includes the spread. */
    conversion: z.boolean().optional(),
  })
  .strict();

export const approvalCancelInputSchema = z.object({ approvalId: z.string().guid(), reason: payReasonSchema }).strict();

export const approvalRequestInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    settlementId: z.string().guid(),
    railId: z.string().min(1).max(64),
  })
  .strict();

/** The step's text fields, with the same limits the form puts on them. A field left out is stored blank. */
export const onboardingDraftFieldsSchema = z
  .object({
    legalName: z.string().max(120).default(''),
    displayName: z.string().max(120).default(''),
    country: z.string().max(2).default(''),
    businessType: z.string().max(80).default(''),
    website: z.string().max(300).default(''),
    contactEmail: z.string().max(320).default(''),
    expectedVolume: z.string().max(200).default(''),
  })
  .strict();

export const onboardingDraftSchema = z.object({ fields: onboardingDraftFieldsSchema, updatedAt: z.string() }).nullable();

export const onboardingDraftSaveInputSchema = z
  .object({ fields: onboardingDraftFieldsSchema, seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .strict();

export const fieldSchema = z.enum(PAY_TRAVEL_RULE_FIELDS);

export const heldDepositViewSchema = z
  .object({
    depositId: z.string(),
    userId: z.string(),
    assetId: brandedAssetIdSchema,
    networkId: z.string(),
    txHash: z.string(),
    amount: z.string(),
    threshold: z.string(),
    ruleVersion: z.number().int(),
    requiredFields: z.array(fieldSchema),
    state: z.enum(PAY_DEPOSIT_TRAVEL_RULE_STATES),
    walletType: z.enum(PAY_DEPOSIT_WALLET_TYPES).nullable(),
    declaredAt: z.string().nullable(),
    waitDeadline: z.string().nullable(),
    openedAt: z.string(),
    lastActor: z.string(),
    lastReason: z.string().nullable(),
  })
  .strict();
