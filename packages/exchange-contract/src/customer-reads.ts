/**
 * svc-trade's spot REST answers (`/api/v1/...`) as the customer's trade desk reads them: its orders with their recovery
 * fields, the dead-man switch, the person's own ledger lines, statement exports, batch cancels, the order preview, the
 * queue position and an order's amends and replaces. Browser-safe (zod only). Every amount is an exact decimal string,
 * checked by contracts' one wire amount rule.
 */
import { z } from 'zod';
import { unsignedAmountSchema as decimalSchema } from '@intafaced/contracts/wire-amount';
import { balancesSchema, orderSchema as contractOrderSchema } from './schemas.js';

/** An exact decimal above zero, as every trade amount and price is. */
const positive = decimalSchema.refine((value) => /[1-9]/.test(value), { error: 'Expected a positive exact decimal string' });

export const orderSchema = contractOrderSchema.extend({
  amount: positive,
  filled: decimalSchema,
  remaining: decimalSchema,
  price: positive.nullable(),
  cost: decimalSchema.nullable(),
  recoveryRequired: z.boolean(),
  recoveryReason: z.string().nullable(),
  reconciliationKey: z.string().nullable(),
});
export type Order = z.infer<typeof orderSchema>;
/**
 * The dead-man switch (cancel-all-after): the caller's countdown and the timeouts the venue publishes, in whole seconds.
 * `timeouts` is null while none are published, and the switch cannot be armed.
 */
export const cancelAllAfterSchema = z.object({
  armed: z.boolean(),
  timeout: z.number().int().nonnegative(),
  triggerTime: z.string().datetime({ offset: true }).nullable(),
  timeouts: z.array(z.number().int().nonnegative()).nullable().optional(),
});
export type CancelAllAfter = z.infer<typeof cancelAllAfterSchema>;

/** One balance change on the person's own account, as the ledger booked it: `referenceId` is the ledger transaction. */
export const ledgerEntrySchema = z.object({
  id: z.string().regex(/^\d{1,19}$/),
  referenceId: z.string().min(1),
  timestamp: z.number().int(),
  datetime: z.string().datetime({ offset: true }),
  currency: z.string().min(1),
  direction: z.enum(['in', 'out']),
  amount: decimalSchema,
  type: z.string(),
  module: z.string(),
  orderId: z.string().nullable(),
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export const ledgerPageSchema = z.object({ entries: z.array(ledgerEntrySchema), nextCursor: z.string().nullable() });
export type LedgerPage = z.infer<typeof ledgerPageSchema>;
/** A statement export job: one per request key, built once; `rows` and `sha256` once it is finished. */
export const statementJobSchema = z.object({
  id: z.string().guid(),
  requestKey: z.string(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  status: z.enum(['pending', 'finished', 'failed']),
  rows: z.object({ orders: z.number().int(), trades: z.number().int(), ledger: z.number().int() }).nullable(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
});
export type StatementJob = z.infer<typeof statementJobSchema>;
export const statementFileSchema = z.object({ filename: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), csv: z.string() });
export type StatementFile = z.infer<typeof statementFileSchema>;
/** One answer per id of a batch cancel, in the order sent: cancelled, refused with the service's reason, or unknown. */
export const batchCancelSchema = z.object({
  atomic: z.literal(false),
  results: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      orderId: z.string().nullable(),
      status: z.enum(['success', 'refused', 'unknown']),
      order: orderSchema.optional(),
      error: z
        .object({ code: z.string().optional(), message: z.string().optional(), intafacedCode: z.string().optional() })
        .passthrough()
        .optional(),
    }),
  ),
});
export type BatchCancel = z.infer<typeof batchCancelSchema>;
export const exitLegFeeSchema = z.object({
  price: positive,
  feeRole: z.enum(['maker', 'taker']),
  feeBps: z.number().int().nonnegative(),
  estimatedFee: decimalSchema,
  feeAsset: z.string(),
});
export const previewSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit', 'stop_limit', 'stop']),
  amount: positive,
  price: positive.nullable(),
  stopPrice: positive.nullable().optional(),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PO', 'GTD']),
  holdAsset: z.string().nullable(),
  holdAmount: decimalSchema.nullable(),
  protectionPrice: positive.nullable(),
  estimatedFee: decimalSchema.nullable(),
  feeAsset: z.string().nullable(),
  feeBps: z.number().int().nonnegative().nullable(),
  feeRole: z.enum(['maker', 'taker']).nullable(),
  /** The maker rebate this market publishes if the order rests (0 = none); absent on older wires. Never a negative fee. */
  makerRebateBps: z.number().int().nonnegative().nullable().optional(),
  orderable: z.boolean(),
  refusals: z.array(
    z.object({ code: z.string(), field: z.string(), message: z.string(), data: z.record(z.string(), z.string()).optional() }),
  ),
  /** The fee each linked exit leg would post if it filled. Absent or null when the draft has no exit legs. */
  exitFees: z
    .object({
      side: z.enum(['buy', 'sell']),
      takeProfit: exitLegFeeSchema,
      stopLoss: exitLegFeeSchema,
    })
    .nullable()
    .optional(),
});
export type Preview = z.infer<typeof previewSchema>;
/**
 * My place in the queue for one of my own resting orders (GET /orders/:id/queue, svc-trade spot/queue-position.ts): the
 * orders and size ahead of it at its price in the native matching queue, and an estimated chance of a fill only when the
 * owner has set the window. With the window blank there is no `fillProbability`, only the reason.
 */
export const queuePositionSchema = z.object({
  orderId: z.string(),
  marketId: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  price: decimalSchema,
  ordersAhead: z.number().int().nonnegative(),
  sizeAhead: decimalSchema,
  remaining: decimalSchema,
  asOfSequence: z.number().int().nonnegative(),
  source: z.literal('native_l3'),
  fillProbability: decimalSchema.optional(),
  fillProbabilityBasis: z
    .object({
      method: z.literal('traded_through_window'),
      windowSeconds: z.number().int().positive(),
      tradedThrough: decimalSchema,
      sizeToFill: decimalSchema,
    })
    .optional(),
  fillProbabilityRefused: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type QueuePosition = z.infer<typeof queuePositionSchema>;

/** One amend or replace of an order, as GET /orders/:id/amendments lists it (oldest first). */
export const orderChangeSchema = z.object({
  kind: z.enum(['amend', 'replace']),
  at: z.string(),
  quantity: decimalSchema.nullable(),
  price: decimalSchema.nullable(),
  version: z.string().nullable(),
  relatedOrderId: z.string().nullable(),
  direction: z.enum(['replaced_by', 'replaces']).nullable(),
});
export const orderChangesSchema = z.object({ orderId: z.string(), amendments: z.array(orderChangeSchema) });
export type OrderChange = z.infer<typeof orderChangeSchema>;

export const amendmentSchema = z.object({
  accepted: z.boolean(),
  idempotent: z.boolean(),
  code: z.string(),
  reasonCode: z.string().nullable(),
  reconciliationRequired: z.boolean(),
  path: z.string(),
  priority: z.enum(['retained', 'lost']).nullable(),
  orderId: z.string(),
  order: orderSchema,
});
export const replacementSchema = z.object({
  accepted: z.boolean(),
  idempotent: z.boolean(),
  code: z.string(),
  reasonCode: z.string().nullable(),
  reconciliationRequired: z.boolean(),
  path: z.literal('CANCEL_REPLACE'),
  originalOrderId: z.string(),
  originalState: z.string(),
  replacementOrderId: z.string().nullable(),
  replacementState: z.string().nullable(),
  original: orderSchema,
  replacement: orderSchema.nullable(),
});

/** `GET /account/balance`, each asset's figures checked as exact decimal strings. */
export const accountBalancesSchema = balancesSchema.extend({
  balances: z.record(z.string(), z.object({ free: decimalSchema, used: decimalSchema, total: decimalSchema })),
});
