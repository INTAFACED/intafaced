/**
 * The answer schemas of `trade.rfq.board`, `trade.algo.list`, `trade.algo.policy` and `trade.options.policy`: each names
 * every key its handler answers with (`answerKeys`) and checks no more than the handler's own type, so a reply leaves
 * exactly as it did before the schema was added.
 */
import { z } from 'zod';
import { answerKeys } from '../answer-keys.js';
import type { AlgoPolicySummary } from '../algo/algo-policy.js';
import type { RfqBoard } from '../otc/rfq-board.js';
import type { OptionsPolicySummary } from '../spot/options-policy.js';
import type { TradeService } from '../spot/trade-service.js';
import { algoPolicyAnswer, algoListAnswer } from '@intafaced/contracts/trade-call-schemas';

const rfqBoardStatus = z.enum(['open', 'accepted', 'settled', 'expired']);
export const rfqBoardAnswer = z.object({
  groups: z
    .array(
      z.object({
        status: rfqBoardStatus,
        count: z.number(),
        requests: z
          .array(
            z.object({
              rfqId: z.string(),
              status: rfqBoardStatus,
              side: z.enum(['buy', 'sell']),
              baseAsset: z.string(),
              quoteAsset: z.string(),
              qty: z.string(),
              createdAt: z.string(),
              quotes: z
                .array(
                  z.object({
                    quoteId: z.string(),
                    makerId: z.string().nullable(),
                    rfqSeq: z.number(),
                    quotedPrice: z.string(),
                    userNotional: z.string(),
                    spreadBps: z.number(),
                    lifecycle: z.enum(['open', 'bound', 'expired', 'settled']),
                    test: z.boolean(),
                    rank: z.number(),
                    best: z.boolean(),
                    expiresAt: z.string(),
                  }),
                )
                .readonly(),
            }),
          )
          .readonly(),
      }),
    )
    .readonly(),
  more: z.boolean(),
});
answerKeys<RfqBoard>()(rfqBoardAnswer);

answerKeys<Awaited<ReturnType<TradeService['algoList']>>>()(algoListAnswer);

answerKeys<AlgoPolicySummary>()(algoPolicyAnswer);

export const optionsPolicyAnswer = z.object({
  socket: z.literal('socket.options-settlement-asset-law'),
  settlementLawUnsetCode: z.literal('trade.options_settlement_law_unset'),
  fixingUnconfiguredCode: z.literal('trade.options_fixing_unconfigured'),
  termsIncompleteCode: z.literal('trade.options_terms_incomplete'),
  settlementAssetLawStamped: z.boolean(),
  settlementFixingConfigured: z.boolean(),
  statusLine: z.string(),
  /** Typed as its one sentence (OPTIONS_SETTLEMENT_RESIDUAL); a string here checks no more than that. */
  residual: z.string(),
  blockers: z.tuple([z.literal('settlement_asset_law'), z.literal('settlement_fixing'), z.literal('european_terms')]).readonly(),
  allowed: z.object({
    nonOptionsListing: z.literal(true),
    optionsListing: z.boolean(),
    optionsOrders: z.boolean(),
    paperOptionsOrders: z.literal(true),
    liveOptionsOrders: z.literal(false),
  }),
  europeanOnly: z.literal(true),
  fullCollateralV1: z.literal(true),
  inventsLiveSet: z.literal(false),
  inventsSettlementAsset: z.literal(false),
  inventsIvSurface: z.literal(false),
  ordersStillRefuseUntilEngine: z.literal(false),
  liveOrdersStillRefuse: z.literal(true),
  paperEngine: z.literal(true),
});
answerKeys<OptionsPolicySummary>()(optionsPolicyAnswer);
