import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  merchantStarterFeeSchema,
  merchantMyAccessSchema,
  merchantPortalMerchantInputSchema,
  merchantBusinessProfileSchema,
  merchantTermsAcceptInputSchema,
  merchantTermsAcceptResultSchema,
  merchantOnboardingProgressSchema,
} from './merchant-portal.js';
import { assetIdSchema, amountSchema, onboardingDraftSchema, onboardingDraftSaveInputSchema } from './pay-call-schemas.js';
import {
  payLinkListInputSchema,
  payLinkListPageSchema,
  payGetLinkInputSchema,
  payLinkListItemSchema,
  payCreateLinkInputSchema,
  payCreateLinkOutputSchema,
} from './pay-payment-links.js';
import {
  payStatementListInputSchema,
  payStatementPageSchema,
  payPayoutDestinationListInputSchema,
  payPayoutDestinationItemSchema,
  payDestinationCancelHoldInputSchema,
  payDestinationCancelHoldOutputSchema,
  payDestinationRemoveOutputSchema,
} from './pay-portal-reads.js';
import { payPageSchema } from './pay-merchant-reads.js';
import { jsonValueSchema } from './procedure-strict-schema.js';
import { merchantCategoryGetInputSchema, merchantCategoryViewSchema, merchantCategoryChooseInputSchema } from './business-category.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchant.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

/**
 * The published starter fee, including for a caller who has no merchant yet.
 * Null means the fee is not configured.
 */
export const PAY_MERCHANT_STARTER_FEE = defineProcedure({
  ...base,
  name: 'pay.merchant.starterFee',
  kind: 'query',
  path: 'merchant.starterFee',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ starterFee: merchantStarterFeeSchema.nullable() }),
  samples: [{ verdict: 'accept' }],
});

/** Current merchant for the principal — null when not yet onboarded. */
export const PAY_MERCHANT_ME = defineProcedure({
  ...base,
  name: 'pay.merchant.me',
  kind: 'query',
  path: 'merchant.me',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: NO_INPUT,
  output: z
    .object({
      id: z.string().guid(),
      userId: z.string().guid(),
      mode: z.enum(['gateway', 'psp', 'payfac']),
      status: z.enum(['pending', 'active', 'suspended', 'closed']),
      kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
      kybRef: z.string().nullable(),
      feeBps: z.number().nullable(),
      /** Null when the starter fee is not set. `local_test` is not INTAFACED pricing. */
      starterFee: merchantStarterFeeSchema.nullable(),
    })
    .nullable(),
  samples: [{ verdict: 'accept' }],
});

/**
 * What we owe this merchant but have not settled, and the settled proceeds
 * they can pay out. Not the owner's trading balance. Both read from the
 * LEDGER, not from svc-pay's tables —
 * the two are independent on purpose, which is what makes reconciliation
 * meaningful (Doctrine §0.6).
 */
export const PAY_MERCHANT_BALANCES = defineProcedure({
  ...base,
  name: 'pay.merchant.balances',
  kind: 'query',
  path: 'merchant.balances',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ merchantId: z.string().guid(), assetId: assetIdSchema }),
  output: z.object({ clearing: amountSchema, available: amountSchema }),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', assetId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_LIST_LINKS = defineProcedure({
  ...base,
  name: 'pay.merchant.listLinks',
  kind: 'query',
  path: 'merchant.listLinks',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: payLinkListInputSchema,
  output: payLinkListPageSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_DEACTIVATE_LINK = defineProcedure({
  ...base,
  name: 'pay.merchant.deactivateLink',
  kind: 'mutation',
  path: 'merchant.deactivateLink',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({
    merchantId: z.string().guid(),
    linkId: z.string().guid(),
    /** Shown to the holder of a deactivated link. Omit or blank stores none. */
    message: z.string().max(500).optional(),
  }),
  output: z.object({ deactivated: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', linkId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * One link, including its checkout path when the credential was stored.
 * Same gate as listLinks: the owner, or a PayFac grant of `payment.link`.
 * The team role table has no link permission, so a stored role is not the owner.
 */
export const PAY_MERCHANT_GET_LINK = defineProcedure({
  ...base,
  name: 'pay.merchant.getLink',
  kind: 'query',
  path: 'merchant.getLink',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: payGetLinkInputSchema,
  output: payLinkListItemSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', linkId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_STATEMENT_LIST = defineProcedure({
  ...base,
  name: 'pay.merchant.statement.list',
  kind: 'query',
  path: 'merchant.statement.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: payStatementListInputSchema,
  output: payStatementPageSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_PAYOUT_DESTINATIONS_LIST = defineProcedure({
  ...base,
  name: 'pay.merchant.payoutDestinations.list',
  kind: 'query',
  path: 'merchant.payoutDestinations.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: payPayoutDestinationListInputSchema,
  output: payPageSchema(payPayoutDestinationItemSchema),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The owner sends a held destination back to unverified (J-merchant-02 #5, the lead's ruling of 2026-10-30).
 * Owner only, interactive, never an API key; no step-up, since it only lowers risk. Idempotent: an
 * unverified destination answers `changed: false`. An active one refuses `pay.payout_destination_not_held`.
 */
export const PAY_MERCHANT_PAYOUT_DESTINATIONS_CANCEL_HOLD = defineProcedure({
  ...base,
  name: 'pay.merchant.payoutDestinations.cancelHold',
  kind: 'mutation',
  path: 'merchant.payoutDestinations.cancelHold',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: payDestinationCancelHoldInputSchema,
  output: payDestinationCancelHoldOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: { merchantId: '11111111-1111-4111-8111-111111111111', destinationId: '11111111-1111-4111-8111-111111111111' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_PAYOUT_DESTINATIONS_SET_DEFAULT = defineProcedure({
  ...base,
  name: 'pay.merchant.payoutDestinations.setDefault',
  kind: 'mutation',
  path: 'merchant.payoutDestinations.setDefault',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({ merchantId: z.string().guid(), destinationId: z.string().guid() }),
  output: payPayoutDestinationItemSchema,
  samples: [
    {
      verdict: 'accept',
      input: { merchantId: '11111111-1111-4111-8111-111111111111', destinationId: '11111111-1111-4111-8111-111111111111' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_PAYOUT_DESTINATIONS_REMOVE = defineProcedure({
  ...base,
  name: 'pay.merchant.payoutDestinations.remove',
  kind: 'mutation',
  path: 'merchant.payoutDestinations.remove',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({ merchantId: z.string().guid(), destinationId: z.string().guid() }),
  output: payDestinationRemoveOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: { merchantId: '11111111-1111-4111-8111-111111111111', destinationId: '11111111-1111-4111-8111-111111111111' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_PROFILE = defineProcedure({
  ...base,
  name: 'pay.merchant.profile',
  kind: 'mutation',
  path: 'merchant.profile',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({
    merchantId: z.string().guid(),
    checkoutConfig: z.record(z.string(), jsonValueSchema).optional(),
    feeRouting: z.record(z.string(), jsonValueSchema).optional(),
    domains: z.array(z.string()).optional(),
  }),
  output: z.object({ id: z.string().guid(), merchantId: z.string().guid() }),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Hosted checkout pointer. The token is the checkout credential.
 * Same key and same body returns the original link, including that token.
 * Same key and a different body is `pay.idempotency_conflict`.
 */
export const PAY_MERCHANT_CREATE_LINK = defineProcedure({
  ...base,
  name: 'pay.merchant.createLink',
  kind: 'mutation',
  path: 'merchant.createLink',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: payCreateLinkInputSchema,
  output: payCreateLinkOutputSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', label: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The business step's saved draft for the signed-in person (J-merchant-02 #1), or null. Kept before any account
 * exists, so leaving the page or signing out never drops what was typed. Never another person's: keyed by session.
 */
export const PAY_MERCHANT_ONBOARDING_DRAFT = defineProcedure({
  ...base,
  name: 'pay.merchant.onboardingDraft',
  kind: 'query',
  path: 'merchant.onboardingDraft',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: NO_INPUT,
  output: onboardingDraftSchema,
  samples: [{ verdict: 'accept' }],
});

/** Saves the business step's draft for the signed-in person, newest `seq` winning. It opens no account. */
export const PAY_MERCHANT_SAVE_ONBOARDING_DRAFT = defineProcedure({
  ...base,
  name: 'pay.merchant.saveOnboardingDraft',
  kind: 'mutation',
  path: 'merchant.saveOnboardingDraft',
  access: { caller: 'scope', scope: 'pay:onboard', module: 'pay' },
  refusals: {},
  input: onboardingDraftSaveInputSchema,
  output: onboardingDraftSchema,
  samples: [
    { verdict: 'accept', input: { fields: {}, seq: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * KYB stub submit — dossier reference only. Does not invent a partner decision.
 * Digital KYB vendors are `pay.psp`.
 */
export const PAY_MERCHANT_SUBMIT_KYB = defineProcedure({
  ...base,
  name: 'pay.merchant.submitKyb',
  kind: 'mutation',
  path: 'merchant.submitKyb',
  access: { caller: 'scope', scope: 'pay:onboard', module: 'pay' },
  refusals: {},
  input: z.object({ merchantId: z.string().guid(), kybRef: z.string().min(1).max(128) }),
  output: z.object({
    id: z.string().guid(),
    kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
    kybRef: z.string().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', kybRef: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_MY_ACCESS = defineProcedure({
  ...base,
  name: 'pay.merchant.myAccess',
  kind: 'query',
  path: 'merchant.myAccess',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: merchantMyAccessSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_BUSINESS_PROFILE_GET = defineProcedure({
  ...base,
  name: 'pay.merchant.businessProfile.get',
  kind: 'query',
  path: 'merchant.businessProfile.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantPortalMerchantInputSchema,
  output: merchantBusinessProfileSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The owner accepts the published terms, on `pay:write` or before verification on `pay:onboard`. Interactive only. */
export const PAY_MERCHANT_TERMS_ACCEPT = defineProcedure({
  ...base,
  name: 'pay.merchant.terms.accept',
  kind: 'mutation',
  path: 'merchant.terms.accept',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay' },
  refusals: {},
  input: merchantTermsAcceptInputSchema,
  output: merchantTermsAcceptResultSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', version: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_ONBOARDING_PROGRESS = defineProcedure({
  ...base,
  name: 'pay.merchant.onboarding.progress',
  kind: 'query',
  path: 'merchant.onboarding.progress',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantPortalMerchantInputSchema,
  output: merchantOnboardingProgressSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * RC-merchant-08: the business category table as the business reads it, and its own choice. The owner, and a
 * team member who can read the profile.
 */
export const PAY_MERCHANT_CATEGORY_GET = defineProcedure({
  ...base,
  name: 'pay.merchant.category.get',
  kind: 'query',
  path: 'merchant.category.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantCategoryGetInputSchema,
  output: merchantCategoryViewSchema,
  outputChecks: {
    reserve_percent_holds: {
      at: ['output.policy.categories[].reserve.percent', 'output.chosen.category.reserve.percent'],
      says: 'above 0',
    },
  },
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The owner picks the category, from an interactive session, before the business is verified. */
export const PAY_MERCHANT_CATEGORY_CHOOSE = defineProcedure({
  ...base,
  name: 'pay.merchant.category.choose',
  kind: 'mutation',
  path: 'merchant.category.choose',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay' },
  refusals: {},
  input: merchantCategoryChooseInputSchema,
  output: merchantCategoryViewSchema,
  outputChecks: {
    reserve_percent_holds: {
      at: ['output.policy.categories[].reserve.percent', 'output.chosen.category.reserve.percent'],
      says: 'above 0',
    },
  },
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', categoryKey: 'sample', expectedTableVersion: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
