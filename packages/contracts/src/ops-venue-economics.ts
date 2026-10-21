/**
 * OPS VENUE ECONOMICS — the cost side of the venue unit-economics report (RC-cex-spot-07).
 *
 * Revenue comes from the analytics warehouse read; costs are operator-entered
 * notes, one per category and period, append-only with a later version
 * superseding an earlier one. A category nobody entered is `not_entered`; it is
 * never read as zero, and a period with any category missing has no total.
 *
 * Browser-safe: zod and string helpers only.
 */

import { z } from 'zod';
import { ledgerFeeRevenueAssetSchema } from './ledger-fee-revenue.js';

export const OPS_COST_CATEGORY_INVALID = 'ops.cost_category_invalid' as const;
export const OPS_COST_AMOUNT_INVALID = 'ops.cost_amount_invalid' as const;
export const OPS_COST_PERIOD_INVALID = 'ops.cost_period_invalid' as const;
export const OPS_COST_STORAGE_UNCONFIGURED = 'ops.cost_storage_unconfigured' as const;

export const OPS_COST_REFUSAL_CODES = [
  OPS_COST_CATEGORY_INVALID,
  OPS_COST_AMOUNT_INVALID,
  OPS_COST_PERIOD_INVALID,
  OPS_COST_STORAGE_UNCONFIGURED,
] as const;

/** The seven cost lines the report must show; a venue is not profitable on fee revenue alone. */
export const OPS_COST_CATEGORIES = [
  'liquidity',
  'insurance_default_capital',
  'custody',
  'data',
  'support',
  'compliance',
  'infrastructure',
] as const;
export type OpsCostCategory = (typeof OPS_COST_CATEGORIES)[number];

/** A calendar month, `2026-10`. Costs are entered and read per period. */
export const opsCostPeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period is a month like 2026-10');

/** A non-negative decimal string. A JS number is refused, not coerced. */
export const opsCostAmountSchema = z
  .string({ invalid_type_error: 'JS number refused — amounts are decimal strings' })
  .regex(/^\d+(\.\d{1,18})?$/, 'cost amounts are non-negative decimal strings (max 18dp)');

const assetSchema = z.string().regex(/^[A-Z0-9]{2,12}$/, 'asset is an upper-case code such as USD');

/** Entry fields as typed by the operator. Category, amount and period are strings so a bad value reaches the typed refusal. */
export const opsCostEntryFieldsSchema = z.object({
  period: z.string(),
  category: z.string(),
  amount: z.string(),
  asset: z.string(),
  sourceNote: z.string().min(1).max(500),
});
export type OpsCostEntryFields = z.infer<typeof opsCostEntryFieldsSchema>;

export const opsCostEntryInputSchema = opsCostEntryFieldsSchema.extend({
  idempotencyKey: z.string(),
  approvalId: z.string(),
  operationId: z.string(),
});
export type OpsCostEntryInput = z.infer<typeof opsCostEntryInputSchema>;

export const opsCostEntrySchema = z.object({
  /** `venue-cost:<period>:<category>:<version>` */
  key: z.string(),
  period: opsCostPeriodSchema,
  category: z.enum(OPS_COST_CATEGORIES),
  version: z.number().int().min(1),
  amount: opsCostAmountSchema,
  asset: assetSchema,
  sourceNote: z.string(),
  enteredBy: z.string(),
  approverId: z.string(),
  enteredAt: z.string(),
});
export type OpsCostEntry = z.infer<typeof opsCostEntrySchema>;

export const opsCostLineSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_entered'), category: z.enum(OPS_COST_CATEGORIES) }),
  z.object({
    status: z.literal('entered'),
    category: z.enum(OPS_COST_CATEGORIES),
    current: opsCostEntrySchema,
    /** Every version, oldest first, so a correction never hides what it replaced. */
    history: z.array(opsCostEntrySchema),
  }),
]);
export type OpsCostLine = z.infer<typeof opsCostLineSchema>;

/** Revenue as the warehouse read answers it, or the typed code it refused with. Not sliced by period. */
export const opsVenueRevenueSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    empty: z.boolean(),
    freshness: z.string(),
    points: z.array(z.object({ metricId: z.string(), value: z.string(), dim: z.string().nullable() })),
  }),
  z.object({ status: z.literal('unavailable'), code: z.string(), message: z.string() }),
]);

export const opsVenueEconomicsSchema = z.object({
  asOf: z.string(),
  period: opsCostPeriodSchema,
  revenue: opsVenueRevenueSchema,
  costs: z.array(opsCostLineSchema),
  /** `complete` only when every category has an entry. Otherwise `missing` names the rest and no total is given. */
  completeness: z.discriminatedUnion('status', [
    z.object({ status: z.literal('complete') }),
    z.object({ status: z.literal('incomplete'), missing: z.array(z.enum(OPS_COST_CATEGORIES)).min(1) }),
  ]),
  /** Sum of the entered costs per asset. Marked partial while any category is missing. */
  costTotals: z.object({ partial: z.boolean(), byAsset: z.array(z.object({ asset: z.string(), amount: z.string() })) }),
  /**
   * Fee revenue the ledger booked in the month, per asset (collected, returned, net of the two). Absent from an
   * answer written before this read existed; `unavailable` names why the ledger could not be asked.
   */
  feeRevenue: z
    .discriminatedUnion('status', [
      z.object({ status: z.literal('ok'), assets: z.array(ledgerFeeRevenueAssetSchema) }),
      z.object({ status: z.literal('unavailable'), code: z.string(), message: z.string() }),
    ])
    .optional(),
  /**
   * Net per asset: the month's fee revenue less the entered costs in the same asset. Given only when the ledger
   * answered and every cost line is entered; otherwise `unavailable` says which is missing. The warehouse points
   * above carry no asset and never enter this figure.
   */
  net: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('unavailable'),
      reason: z.enum(['revenue_asset_unknown', 'revenue_unavailable', 'costs_incomplete']),
    }),
    z.object({
      status: z.literal('ok'),
      byAsset: z.array(
        z.object({
          asset: z.string(),
          /** Fees collected less fees returned. May be negative. */
          revenue: z.string().regex(/^-?\d+(\.\d{1,18})?$/),
          costs: z.string().regex(/^\d+(\.\d{1,18})?$/),
          /** `revenue` less `costs`. May be negative. */
          net: z.string().regex(/^-?\d+(\.\d{1,18})?$/),
        }),
      ),
    }),
  ]),
});
export type OpsVenueEconomics = z.infer<typeof opsVenueEconomicsSchema>;
