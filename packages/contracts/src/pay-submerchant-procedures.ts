import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { subMerchantView, MAX_FEE_BPS, subMerchantSummaryView } from './pay-call-schemas.js';
import { jsonValueSchema } from './procedure-strict-schema.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `submerchant.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

/** Direct children of a node the caller can reach. Requires `submerchant`. */
export const PAY_SUBMERCHANT_LIST = defineProcedure({
  ...base,
  name: 'pay.submerchant.list',
  kind: 'query',
  path: 'submerchant.list',
  access: { caller: 'scope', scope: 'pay:read', module: 'pay' },
  refusals: {},
  input: z.object({
    merchantId: z.string().guid(),
    /**
     * Page size. Optional so omit reaches `pay.submerchant_list_limit_unset`.
     * Blank is not 100; pass 100 explicitly.
     */
    limit: z.number().int().min(1).max(500).optional(),
  }),
  output: z.array(subMerchantView),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One node's record. Requires `merchant.profile`, not `submerchant`. */
export const PAY_SUBMERCHANT_GET = defineProcedure({
  ...base,
  name: 'pay.submerchant.get',
  kind: 'query',
  path: 'submerchant.get',
  access: { caller: 'scope', scope: 'pay:read', module: 'pay' },
  refusals: {},
  input: z.object({ merchantId: z.string().guid() }),
  output: subMerchantView,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Onboard a sub-merchant under a node inside the caller's own subtree.
 *
 * `userId` IS AN INPUT HERE, and that is the one place in this router it
 * is. A sub-merchant is a sovereign account that is NOT the caller's —
 * that is the whole point of a tree — so the account being onboarded has
 * to be named. What stops it being an escalation is that naming an account
 * that already has a merchant is refused (`pay.submerchant_user_already_merchant`)
 * rather than adopting their existing row: onboarding creates a node, it
 * never captures one.
 *
 * `mode` is not an input. A node under a parent is `payfac` by
 * construction, and letting a caller choose would let them create a
 * sub-merchant that claims to be a standalone gateway merchant.
 */
export const PAY_SUBMERCHANT_CREATE = defineProcedure({
  ...base,
  name: 'pay.submerchant.create',
  kind: 'mutation',
  path: 'submerchant.create',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({
    parentMerchantId: z.string().guid(),
    userId: z.string().min(1).max(128),
    pricing: z.object({ feeBps: z.number().int().min(0).max(MAX_FEE_BPS) }),
    /**
     * Optional, and `'self'` is the only accepted value today. It is on
     * the wire rather than hidden so a caller that needs a sponsor gets
     * the honest refusal by name instead of silently being settled to
     * themselves. See `SETTLING_PARTY_SELF`.
     */
    settlingParty: z.string().min(1).max(64).optional(),
    settlementPrefs: z.record(z.string(), jsonValueSchema).optional(),
  }),
  output: subMerchantView,
  samples: [
    { verdict: 'accept', input: { parentMerchantId: '11111111-1111-4111-8111-111111111111', userId: 'USDC', pricing: { feeBps: 0 } } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Child summary for `/pay/network/:child`. Same subtree fence as `get`.
 * Volume and recent payments are present only with `payment`. Grants are
 * present only with `permission`. A missing area is null.
 */
export const PAY_SUBMERCHANT_SUMMARY = defineProcedure({
  ...base,
  name: 'pay.submerchant.summary',
  kind: 'query',
  path: 'submerchant.summary',
  access: { caller: 'scope', scope: 'pay:read', module: 'pay' },
  refusals: {},
  input: z
    .object({
      merchantId: z.string().guid(),
      recentPaymentsLimit: z.number().int().min(1).max(200).optional(),
      grantsLimit: z.number().int().min(1).max(200).optional(),
      recentPaymentsCursor: z.string().min(1).max(300).optional(),
    })
    .strict(),
  output: subMerchantSummaryView,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
