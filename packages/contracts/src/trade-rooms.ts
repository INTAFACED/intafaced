/**
 * svc-trade's answers the Options, Execution and Quote desk rooms read (algo, OTC, RFQ, options, batch and iceberg
 * orders), as those rooms read them. Browser-safe (zod only). Money stays an exact decimal string.
 */
import { z } from 'zod';
import { signedAmountSchema, unsignedAmountSchema } from './wire-amount.js';

/** `algo.result`: per quote asset, the average price of the real child fills — null while nothing has filled. */
export const algoResultSchema = z.object({
  quotes: z.array(z.object({ quoteAsset: z.string(), filledQty: unsignedAmountSchema, averageFillPrice: unsignedAmountSchema.nullable() })),
});
export type AlgoResult = z.infer<typeof algoResultSchema>;

/** `algo.list`: the person's schedules as the service keeps them, newest first, so every browser shows the same list. */
export const algoListSchema = z.object({ rows: z.array(z.object({ id: z.string() })), nextCursor: z.string().nullable() });
export type AlgoListPage = z.infer<typeof algoListSchema>;

export const algoPolicySchema = z.object({
  productKind: z.string(),
  capability: z.object({ createEnabled: z.boolean(), jobsEnabled: z.boolean(), icebergs: z.string() }),
  immatureKinds: z.array(z.string()),
  volumeImmatureCode: z.string(),
  cancelIncompleteCode: z.string(),
});
export type AlgoPolicy = z.infer<typeof algoPolicySchema>;

/** `otc.makers.list` (CB-otc-01): the owner's provider list and pick cap, or the honest empty state. */
export const otcMakersSchema = z.object({
  published: z.boolean(),
  makers: z.array(z.object({ id: z.string(), name: z.string(), route: z.enum(['platform', 'outside']) })),
  selectCap: z.number().int().nullable(),
  emptyLabel: z.string().nullable(),
});
export type OtcMakers = z.infer<typeof otcMakersSchema>;

export const deskStatusSchema = z.object({
  published: z.boolean(),
  statusLine: z.string(),
  residual: z.string().nullable().optional(),
  /** CB-otc-11: the base assets the desk quotes; null when the owner left the list blank. */
  assets: z.array(z.string()).nullable().optional(),
  /** CB-otc-08: the lowest verification level the desk prices for; null when the owner left it blank. */
  minTier: z.string().nullable().optional(),
  makerRouting: z.object({ published: z.boolean(), residual: z.string().nullable().optional() }).optional(),
  midFeed: z.object({ wiring: z.string(), published: z.boolean(), residual: z.string().nullable().optional() }).optional(),
});
export type DeskStatus = z.infer<typeof deskStatusSchema>;

const rfqBoardStatusSchema = z.enum(['open', 'accepted', 'settled', 'expired']);
/** `rfq.board` (CB-otc-02): the caller's requests grouped by status with counts, each with its quotes ranked best first. */
export const rfqBoardSchema = z.object({
  groups: z.array(
    z.object({
      status: rfqBoardStatusSchema,
      count: z.number().int(),
      requests: z.array(
        z.object({
          rfqId: z.string(),
          status: rfqBoardStatusSchema,
          side: z.enum(['buy', 'sell']),
          baseAsset: z.string(),
          quoteAsset: z.string(),
          qty: unsignedAmountSchema,
          createdAt: z.string(),
          quotes: z.array(
            z.object({
              quoteId: z.string(),
              makerId: z.string().nullable(),
              rfqSeq: z.number().int(),
              quotedPrice: unsignedAmountSchema,
              userNotional: unsignedAmountSchema,
              spreadBps: z.number().int(),
              lifecycle: z.string(),
              test: z.boolean(),
              rank: z.number().int(),
              best: z.boolean(),
              expiresAt: z.string(),
            }),
          ),
        }),
      ),
    }),
  ),
  more: z.boolean(),
});
export type RfqBoard = z.infer<typeof rfqBoardSchema>;
export type RfqBoardStatus = z.infer<typeof rfqBoardStatusSchema>;

const convertFlowBoundsSchema = z.object({ minQty: unsignedAmountSchema, maxQty: unsignedAmountSchema }).nullable();
/** `otc.convertBounds` (CB-otc-12): the owner's size range for each flow at the desk price; null when it is blank. */
export const convertBoundsSchema = z.object({ convert: convertFlowBoundsSchema, oneClickBuy: convertFlowBoundsSchema });
export type ConvertBounds = z.infer<typeof convertBoundsSchema>;

export const optionsPolicySchema = z.object({
  settlementAssetLawStamped: z.boolean(),
  settlementFixingConfigured: z.boolean(),
  blockers: z.array(z.string()),
  residual: z.string(),
  statusLine: z.string(),
  allowed: z.object({ optionsOrders: z.boolean(), paperOptionsOrders: z.boolean(), liveOptionsOrders: z.boolean() }),
  europeanOnly: z.boolean(),
  fullCollateralV1: z.boolean(),
});
export type OptionsPolicy = z.infer<typeof optionsPolicySchema>;

export const greeksSchema = z.union([
  // Greeks are signed: a put delta and a long option's theta are negative.
  z.object({
    ok: z.literal(true),
    npv: signedAmountSchema,
    delta: signedAmountSchema,
    gamma: signedAmountSchema,
    vega: signedAmountSchema,
    theta: signedAmountSchema,
  }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string(), field: z.string().optional() }),
]);
export type GreeksAnswer = z.infer<typeof greeksSchema>;

/** One item of `POST /orders/batch`: the service answers each order on its own, and never rolls the group back. */
export const batchItemSchema = z.object({
  index: z.number().int(),
  clientOrderId: z.string().nullable(),
  status: z.enum(['success', 'refused', 'unknown']),
  order: z.object({ id: z.string(), status: z.string() }).passthrough().optional(),
  error: z.object({ message: z.string(), intafacedCode: z.string().optional() }).passthrough().optional(),
});
export type BatchItem = z.infer<typeof batchItemSchema>;
export const batchSchema = z.object({ results: z.array(batchItemSchema) });

/** The order door's answer to one iceberg: the order id, its status and the display size the service stored. */
export const icebergAnswerSchema = z.object({ id: z.string(), status: z.string(), displayQty: z.string().optional() });

export const previewSizesSchema = z.object({ sliceQtys: z.array(unsignedAmountSchema) });
