import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { merchantCustomerSeriesInputSchema, merchantCustomerSeriesSchema } from './merchant-portal.js';
import { merchantActivationSchema } from './merchant-activation.js';
import { id } from './pay-founder-admin-procedures.js';
import { PAY_EXPORT_KINDS, payExportJobSchema } from './pay-portal-reads.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantOps.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_OPS_CUSTOMERS_SERIES = defineProcedure({
  ...base,
  name: 'pay.merchantOps.customers.series',
  kind: 'query',
  path: 'merchantOps.customers.series',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantCustomerSeriesInputSchema,
  output: merchantCustomerSeriesSchema,
  samples: [
    { verdict: 'accept', input: { customerRef: 'USDC', from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z', bucket: 'day' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_ACTIVATION_GET = defineProcedure({
  ...base,
  name: 'pay.merchantOps.activation.get',
  kind: 'query',
  path: 'merchantOps.activation.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: merchantActivationSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const iso = z.string().datetime({ offset: true });

export const assetIdIn = z.string().trim().min(1).max(32);

export const PAY_MERCHANT_OPS_EXPORTS_CREATE = defineProcedure({
  ...base,
  name: 'pay.merchantOps.exports.create',
  kind: 'mutation',
  path: 'merchantOps.exports.create',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: z.object({
    requestId: id,
    kind: z.enum(PAY_EXPORT_KINDS),
    filters: z
      .object({
        from: iso.optional(),
        to: iso.optional(),
        status: z.string().max(32).optional(),
        assetId: assetIdIn.optional(),
        amountMin: z.string().optional(),
        amountMax: z.string().optional(),
      })
      .strict()
      .default({}),
    columns: z
      .array(z.string().regex(/^[a-z_]{1,64}$/))
      .max(32)
      .optional(),
    /** M-rep-01: local days in a time zone; the server computes the UTC boundaries. Not combined with filters.from/to. */
    period: z
      .object({
        fromDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        toDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        timeZone: z.string().trim().min(1).max(64),
      })
      .strict()
      .optional(),
  }),
  output: payExportJobSchema,
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111', kind: 'payments' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_TEAM_DECLINE_INVITE = defineProcedure({
  ...base,
  name: 'pay.merchantOps.team.declineInvite',
  kind: 'mutation',
  path: 'merchantOps.team.declineInvite',
  access: { caller: 'signedIn', check: 'membershipExit' },
  refusals: {},
  input: z.object({ memberId: id }),
  output: z.object({ declined: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { memberId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
