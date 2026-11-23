import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountSchema } from './pay-subscription-procedures.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `mandate.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const mandateView = z.object({
  id: z.string().guid(),
  merchantId: z.string().guid(),
  customerId: z.string(),
  assetId: assetIdSchema,
  amount: amountSchema,
  ceiling: amountSchema.nullable(),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullable(),
  railAdapter: z.string().nullable(),
  railMandateRef: z.string().nullable(),
  status: z.enum(['active', 'cancelled', 'expired']),
  cancelledAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

/**
 * Merchant fleet list (ops truth). Read-only — no charge, no cascade.
 */
export const PAY_MANDATE_LIST = defineProcedure({
  ...base,
  name: 'pay.mandate.list',
  kind: 'query',
  path: 'mandate.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({
    merchantId: z.string().guid(),
    status: z.enum(['active', 'cancelled', 'expired']).optional(),
    /**
     * Page size. Optional so omit reaches `pay.subscription_mandate_list_limit_unset`.
     * Blank is not 50; pass 50 explicitly.
     */
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(300).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  }),
  output: z.object({ items: z.array(mandateView), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Immediate mandate cancel (SPEC §4). Cascades to active subscriptions.
 * Does not reverse settled executions.
 */
export const PAY_MANDATE_CANCEL = defineProcedure({
  ...base,
  name: 'pay.mandate.cancel',
  kind: 'mutation',
  path: 'mandate.cancel',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({ mandateId: z.string().guid() }),
  output: mandateView,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Store a recurring mandate. Does not charge. Card mandate rail still
 * refuses at fire time (`pay.mandate_rail_absent`); crypto is invoice-and-watch.
 */
export const PAY_MANDATE_CREATE = defineProcedure({
  ...base,
  name: 'pay.mandate.create',
  kind: 'mutation',
  path: 'mandate.create',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({
    merchantId: z.string().guid(),
    customerId: z.string().min(1).max(128),
    assetId: assetIdSchema.min(1).max(16),
    amount: amountSchema,
    ceiling: amountSchema.optional(),
    cadence: z.enum(['daily', 'weekly', 'monthly']),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).optional(),
    railAdapter: z.string().min(1).max(64).optional(),
    railMandateRef: z.string().min(1).max(256).optional(),
  }),
  output: mandateView,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
