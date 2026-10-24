import { z } from 'zod';

/**
 * The payment methods a business's hosted checkout offers (M-adv-payments-core-11 with the method catalogue of
 * M-payments-core-07, J-merchant-04 step 7): `merchantCheckoutMethods.*` on svc-pay.
 *
 * The catalogue is fixed. A method is connected when the platform has a rail that takes it on the public checkout;
 * one with no rail names the missing piece (`rail.crypto`, `rail.card` for cards and pay later, `rail.bank` for bank debit) and is
 * never offered as payable. The business sets the order, which methods are on, and per method an optional minimum and
 * maximum in one asset (blank is no rule, never a default). A business that never saved has the catalogue order with
 * only the connected methods on, which is what the checkout offered before this existed.
 *
 * Which methods a payer is offered depends on the payer's country (the connected rail's declared countries), the
 * payment's currency (crypto for the crypto method, a fiat currency for the others) and its amount (the rules). The
 * preview answers the same question the hosted page asks, so the owner reads what a payer would be offered. Every team
 * role reads; the owner and admins change it, from an interactive session. Nothing here moves money.
 */
export const CHECKOUT_METHODS = ['crypto', 'card', 'bank_debit', 'pay_later'] as const;
export const checkoutMethodIdSchema = z.enum(CHECKOUT_METHODS);
export type CheckoutMethodId = z.infer<typeof checkoutMethodIdSchema>;

/** The outside piece a method waits for when no rail takes it. */
export const CHECKOUT_METHOD_NOTICES = ['rail.crypto', 'rail.card', 'rail.bank'] as const;
export const checkoutMethodNoticeSchema = z.enum(CHECKOUT_METHOD_NOTICES);
export type CheckoutMethodNotice = z.infer<typeof checkoutMethodNoticeSchema>;

/** A decimal amount for a rule: digits with at most 18 places, no sign, no exponent. */
const ruleAmountSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,18})?$/, 'an amount like 25 or 0.5')
  .refine((v) => /[1-9]/.test(v), 'must be greater than zero');

/** An asset code as the payment links use it. */
const assetCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{2,12}$/, 'an asset code like USDT')
  .transform((v) => v.toUpperCase());

/** One method as the business set it. A rule asset is named exactly when a minimum or a maximum is. */
export const checkoutMethodRuleSchema = z
  .object({
    method: checkoutMethodIdSchema,
    enabled: z.boolean(),
    ruleAsset: assetCodeSchema.nullable(),
    minAmount: ruleAmountSchema.nullable(),
    maxAmount: ruleAmountSchema.nullable(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const hasBound = rule.minAmount !== null || rule.maxAmount !== null;
    if (hasBound && rule.ruleAsset === null)
      ctx.addIssue({ code: 'custom', path: ['ruleAsset'], message: 'name the asset the minimum and maximum are in' });
    if (!hasBound && rule.ruleAsset !== null)
      ctx.addIssue({ code: 'custom', path: ['ruleAsset'], message: 'an asset needs a minimum or a maximum' });
  });
export type CheckoutMethodRule = z.infer<typeof checkoutMethodRuleSchema>;

export const checkoutMethodConnectionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('connected') }).strict(),
  z.object({ state: z.literal('not_connected'), notice: checkoutMethodNoticeSchema }).strict(),
]);
export type CheckoutMethodConnection = z.infer<typeof checkoutMethodConnectionSchema>;

/** The business's methods in its order, each with whether the platform can take it. */
export const checkoutMethodsSchema = z
  .object({
    /** `default` until the first save: the catalogue order with the connected methods on. */
    status: z.enum(['default', 'saved']),
    /** 0 for the default. */
    version: z.number().int().min(0),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
    methods: z.array(
      z
        .object({
          rule: checkoutMethodRuleSchema,
          connection: checkoutMethodConnectionSchema,
          /** The payment currencies this method is for. */
          currencies: z.enum(['crypto', 'fiat']),
        })
        .strict(),
    ),
  })
  .strict();
export type CheckoutMethods = z.infer<typeof checkoutMethodsSchema>;

export const checkoutMethodsGetInputSchema = z.object({}).strict();

export const checkoutMethodsSaveInputSchema = z
  .object({
    requestId: z.string().guid(),
    /** The version this save was made from: 0 for the default. An older one refuses `pay.checkout_methods_stale`. */
    expectedVersion: z.number().int().min(0),
    /** Every catalogue method exactly once, in the order the checkout offers them. */
    methods: z.array(checkoutMethodRuleSchema).length(CHECKOUT_METHODS.length),
  })
  .strict()
  .superRefine((input, ctx) => {
    const seen = new Set(input.methods.map((m) => m.method));
    if (seen.size !== CHECKOUT_METHODS.length)
      ctx.addIssue({ code: 'custom', path: ['methods'], message: 'name every method exactly once' });
  });
export type CheckoutMethodsSaveInput = z.infer<typeof checkoutMethodsSaveInputSchema>;

export const checkoutMethodsSavedSchema = z
  .object({
    methods: checkoutMethodsSchema,
    replayed: z.boolean(),
  })
  .strict();

/** Why a method is not offered for a payment. */
export const CHECKOUT_METHOD_LEFT_OUT = ['off', 'currency', 'country', 'below_min', 'above_max'] as const;
export const checkoutMethodLeftOutSchema = z.enum(CHECKOUT_METHOD_LEFT_OUT);

export const checkoutMethodsPreviewInputSchema = z
  .object({
    /** ISO 3166-1 alpha-2, as the payer states it. */
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'a two-letter country code like DE')
      .transform((v) => v.toUpperCase()),
    currency: assetCodeSchema,
    /** Optional: without it the minimum and maximum rules are not applied. */
    amount: ruleAmountSchema.optional(),
  })
  .strict();
export type CheckoutMethodsPreviewInput = z.infer<typeof checkoutMethodsPreviewInputSchema>;

/** What a payer in that country paying that currency and amount is offered, in the business's order, and what is left out. */
export const checkoutMethodOfferSchema = z
  .object({
    offered: z.array(z.object({ method: checkoutMethodIdSchema, connection: checkoutMethodConnectionSchema }).strict()),
    leftOut: z.array(z.object({ method: checkoutMethodIdSchema, reason: checkoutMethodLeftOutSchema }).strict()),
  })
  .strict();
export type CheckoutMethodOffer = z.infer<typeof checkoutMethodOfferSchema>;
