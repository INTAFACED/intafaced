import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { merchantStarterFeeSchema } from './merchant-portal.js';
import { assetIdSchema, amountSchema } from './pay-call-schemas.js';
import { payLinkListInputSchema, payLinkListPageSchema, payGetLinkInputSchema, payLinkListItemSchema } from './pay-payment-links.js';

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
