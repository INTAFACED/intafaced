// The Copy and Bots rooms' reads and writes. Every call here already exists in the service (VERIFIED against
// the local stack on 2026-10-17); the shapes mirror the legacy `features/trade/tool-api.ts`, which stays the owner of
// the calls both rooms share. Only fields the screen shows are kept, and no service sentence is ever kept
// (`residual` and `statusLine` are deliberately left out of the schema).
import { z } from 'zod';
import { decimalSchema, signedDecimalSchema } from '../../../shared/money';
import type { ApiClient } from '../../../shared/api';
import { algoSchema, copyFollowSchema, createToolApi } from '../../../features/trade/tool-api';

export const copyDeskSchema = z.object({
  feeSharePublished: z.boolean(),
  jurisdictionPublished: z.boolean(),
  leaderShareBps: z.string().nullable(),
  autoMirrorPlace: z.object({ published: z.boolean() }).optional(),
});
export type CopyDesk = z.infer<typeof copyDeskSchema>;

const ackSchema = z.object({ followId: z.string(), relationshipState: z.string(), newIntentFenced: z.boolean(), disposition: z.string() });

/** A chart alert webhook (svc-trade `signals.webhooks.*`): one venue market and account. `token` is in the create reply only, once. */
export const signalWebhookSchema = z.object({
  webhookId: z.string(),
  symbol: z.string(),
  venueOwner: z.string(),
  path: z.string(),
  tokenPrefix: z.string(),
  state: z.enum(['active', 'paused', 'ended']),
  createdAt: z.string(),
  token: z.string().nullable().optional(),
});
export type SignalWebhook = z.infer<typeof signalWebhookSchema>;
/** The scopes the platform has paused now (svc-trade `copy.platformPauses`, CB-ops-03). */
export const platformPausesSchema = z.object({
  leads: z.array(z.string()),
  botTypes: z.array(z.string()),
  symbols: z.array(z.string()),
});
export type PlatformPauses = z.infer<typeof platformPausesSchema>;

export const algoPolicySchema = z.object({
  capability: z.object({ createEnabled: z.boolean(), jobsEnabled: z.boolean() }),
  immatureKinds: z.array(z.string()),
});
export type AlgoPolicy = z.infer<typeof algoPolicySchema>;

/** One of the person's bots, as the service lists it (newest first). The list is the service's, so it is the same in every browser. */
export const botListRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  market: z.string(),
  side: z.enum(['buy', 'sell']),
  totalQty: decimalSchema,
  filledQty: decimalSchema,
  status: z.enum(['active', 'paused', 'cancelled', 'completed', 'halted']),
  created: z.string(),
});
export type BotListRow = z.infer<typeof botListRowSchema>;
const botListSchema = z.object({ rows: z.array(botListRowSchema), nextCursor: z.string().nullable() });
/** Bots My bots reads at a time. The service refuses a list read without a limit, and lists at most 500 a read. */
export const BOT_LIST_PAGE = 50;
export const BOT_LIST_MAX = 500;

export const studioStrategySchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  cash: decimalSchema,
  risk: z.object({ maxDrawdown: decimalSchema, maxNotional: decimalSchema, kill: decimalSchema }),
  environment: z.string(),
  claimLabel: z.string(),
  live: z.boolean(),
  simulated: z.boolean(),
});
export type StudioStrategy = z.infer<typeof studioStrategySchema>;

const held = <T extends z.ZodTypeAny>(value: T) => z.object({ value: value.nullable(), reason: z.string().nullable() });

export const LEADER_MODES = ['spot', 'futures', 'bot', 'signal'] as const;
export type LeaderMode = (typeof LEADER_MODES)[number];

/** One listed leader, as the operator published it. No user id is ever in it. */
export const leaderRowSchema = z.object({
  leaderRef: z.string(),
  displayName: z.string(),
  marketMode: z.enum(LEADER_MODES),
  recordKind: z.string(),
  tenureStart: z.string().nullable(),
  assets: z.array(z.string()),
  publishedReturn: held(signedDecimalSchema),
  maximumDrawdown: held(signedDecimalSchema),
  copiersCount: z.number(),
  capacity: held(z.number()),
  leaderShareBps: held(z.string()),
});
export type LeaderRow = z.infer<typeof leaderRowSchema>;
const leaderPageSchema = z.object({ leaders: z.array(leaderRowSchema), nextCursor: z.string().nullable() });

export const leaderProfileSchema = z.object({
  leader: leaderRowSchema,
  status: z.string(),
  definitionsVersion: z.string().nullable(),
  metrics: z.array(
    z.object({
      key: z.enum(['publishedReturn', 'maximumDrawdown', 'winRate', 'sharpeRatio']),
      value: z.string().nullable(),
      reason: z.string().nullable(),
      definition: z.string().nullable(),
    }),
  ),
});
export type LeaderProfile = z.infer<typeof leaderProfileSchema>;

export const leaderTradeSchema = z.object({
  tradeId: z.string(),
  symbol: z.string(),
  state: z.enum(['open', 'closed']),
  openedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  entryPrice: decimalSchema.nullable(),
  qty: decimalSchema,
  margin: decimalSchema.nullable(),
  takeProfit: decimalSchema.nullable(),
  stopLoss: decimalSchema.nullable(),
  closePrice: decimalSchema.nullable(),
  closedQty: decimalSchema,
  roiPercent: signedDecimalSchema.nullable(),
});
export type LeaderTrade = z.infer<typeof leaderTradeSchema>;
const leaderTradesSchema = z.object({ trades: z.array(leaderTradeSchema), nextCursor: z.string().nullable() });

/** Leaders per directory page and trades per lead page. The service refuses a read without one. */
/** One order the copy placed for this person, read from their own order book. */
export const copyPositionSchema = z.object({
  orderId: z.string(),
  market: z.string(),
  side: z.enum(['buy', 'sell']),
  qty: decimalSchema,
  filledQty: decimalSchema,
  price: decimalSchema,
  status: z.string(),
  placedAt: z.string(),
});
export type CopyPosition = z.infer<typeof copyPositionSchema>;

/** A spot grid bot as the service reports it (trade.bots.grid). Every amount is the service's decimal string. */
export const gridBotSchema = z.object({
  botId: z.string(),
  clientRequestId: z.string(),
  symbol: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  lowerPrice: decimalSchema,
  upperPrice: decimalSchema,
  gridCount: z.number(),
  investment: decimalSchema,
  status: z.enum(['initializing', 'running', 'paused_range', 'initialization_failed', 'stopped']),
  statusReason: z.string().nullable(),
  reserve: z.object({ key: z.string(), asset: z.string(), amount: decimalSchema, releasedAt: z.string().nullable() }).nullable(),
  levels: z.array(
    z.object({
      index: z.number(),
      price: decimalSchema,
      qty: decimalSchema,
      hold: decimalSchema,
      openOrder: z.object({ side: z.enum(['buy', 'sell']), orderId: z.string(), clientOrderId: z.string() }).nullable(),
    }),
  ),
  orders: z.array(
    z.object({
      clientOrderId: z.string(),
      orderId: z.string(),
      levelIndex: z.number(),
      side: z.enum(['buy', 'sell']),
      cycle: z.number(),
      price: decimalSchema,
      qty: decimalSchema,
      holdAmount: decimalSchema,
      status: z.enum(['open', 'filled', 'partial', 'cancelled']),
      pairProfit: signedDecimalSchema.nullable(),
    }),
  ),
  gridProfit: signedDecimalSchema,
  closedPairs: z.number(),
  withdrawableProfit: decimalSchema,
  gridApr: z.discriminatedUnion('state', [
    z.object({ state: z.literal('under_a_day'), percent: z.null() }),
    z.object({ state: z.literal('set'), percent: signedDecimalSchema }),
  ]),
  createdAt: z.string(),
});
export type GridBot = z.infer<typeof gridBotSchema>;
/** A grid profit withdrawal receipt: the stored withdrawal row (trade.bots.grid.withdrawProfit, CB-bots-05). */
export const gridWithdrawalSchema = z.object({
  withdrawalId: z.string(),
  botId: z.string(),
  asset: z.string(),
  amount: decimalSchema,
  profitBefore: decimalSchema,
  profitAfter: decimalSchema,
  reserveBefore: decimalSchema,
  reserveAfter: decimalSchema,
  dailyCap: decimalSchema,
  capUsed: decimalSchema,
  capRemaining: decimalSchema,
  stepUpEventId: z.string(),
  appliedAt: z.string(),
});
export type GridWithdrawal = z.infer<typeof gridWithdrawalSchema>;
export type GridWithdrawRequest = {
  botId: string;
  requestId: string;
  asset: string;
  amount: string;
  stepUpApprovalId: string | null;
};
export const gridSetupSchema = z.object({
  countRange: z.object({ min: z.number(), max: z.number() }).nullable(),
  boundsMaxDistanceBps: z.number().nullable(),
});
export type GridSetup = z.infer<typeof gridSetupSchema>;
const gridPresetsSchema = z.object({ source: z.null(), presets: z.array(z.never()) });
export type GridRequest = {
  clientRequestId: string;
  symbol: string;
  /** Blank fields are sent as they are, so the service names the one that is missing. */
  lowerPrice: string;
  upperPrice: string;
  gridCount: number | null;
  investment: string;
};
/** One copied buy and what of it is still open (CB-copy-09/10). Amounts are in the market's base asset. */
export const copiedPositionSchema = z.object({
  positionId: z.string(),
  market: z.string(),
  bought: decimalSchema,
  open: decimalSchema,
  closing: decimalSchema,
  status: z.enum(['buying', 'open', 'closing', 'closed']),
  placedAt: z.string(),
});
export type CopiedPosition = z.infer<typeof copiedPositionSchema>;
/** One market's copied position by average entry (J-copy-bots-otc-06 #2). A spot position has no funding: null. */
export const copiedMarketSchema = z.object({
  market: z.string(),
  fills: z.number().int().nullable(),
  filled: decimalSchema.nullable(),
  open: decimalSchema,
  averageEntry: decimalSchema.nullable(),
  funding: decimalSchema.nullable(),
});
export type CopiedMarket = z.infer<typeof copiedMarketSchema>;

/** A lead's own earnings: fee-share rows only, and the profit-share sentence (J-copy-bots-otc-06 #3). */
export const leadEarningsSchema = z.object({
  profitShare: z.string(),
  leaderShareBps: z.string().nullable(),
  totals: z.array(z.object({ assetId: z.string(), amount: decimalSchema })),
  items: z.array(
    z.object({
      fillId: z.string(),
      followId: z.string(),
      assetId: z.string(),
      feeOnFill: decimalSchema,
      appliedShareBps: z.number().int(),
      amount: decimalSchema,
      at: z.string(),
    }),
  ),
});
export type LeadEarnings = z.infer<typeof leadEarningsSchema>;
export const LEAD_EARNINGS_PAGE = 50;

/** A lead's level: null while the owner's thresholds are blank; the maximum ratio is never set (J-copy-bots-otc-06 #5). */
export const leadLevelSchema = z.object({
  leaderRef: z.string().nullable(),
  listingState: z.string().nullable(),
  level: z.string().nullable(),
  levelReason: z.string(),
  maxRatio: z.string().nullable(),
});
export type LeadLevel = z.infer<typeof leadLevelSchema>;

const closePositionSchema = z.object({ positionId: z.string(), orderId: z.string(), qty: decimalSchema, duplicate: z.boolean() });

/** A leader fill this follow did not copy (CB-copy-11). The reason is an id; the screen says it in words. */
export const copySkipSchema = z.object({ leaderFillId: z.string(), reason: z.string(), at: z.string() });
export type CopySkip = z.infer<typeof copySkipSchema>;

export const LEADER_PAGE = 50;
export const LEADER_TRADES_PAGE = 20;

export type FollowRequest = {
  leaderId?: string;
  leaderRef?: string;
  region: string;
  permittedMarkets: string[];
  maxNotionalPerOrder: string;
  maxAggregateExposure: string;
  maxLoss?: string;
  /** Quote amount each copied order uses. Left out means no fixed size. */
  fixedOrderSize?: string;
  expiresAt: string;
  /** This Start copying request's own key: pressing again returns the same follow. */
  clientRequestId: string;
};
export type TwapRequest = {
  symbol: string;
  side: 'buy' | 'sell';
  totalQty: string;
  durationMs: number;
  sliceIntervalMs: number;
  limitPrice?: string;
  clientAlgoId: string;
  kind: 'twap' | 'vwap' | 'pov';
  participationBps?: number;
};

export function createRoomApi(api: ApiClient) {
  const tools = createToolApi(api);
  return {
    copyDesk: (signal?: AbortSignal) => api.query('trade', 'copy.deskStatus', undefined, copyDeskSchema, { signal }),
    leaders: (query: { marketMode?: LeaderMode; q?: string; cursor?: string }, signal?: AbortSignal) =>
      api.query(
        'trade',
        'copy.listLeaders',
        {
          limit: LEADER_PAGE,
          ...(query.marketMode ? { marketMode: query.marketMode } : {}),
          ...(query.q?.trim() ? { q: query.q.trim() } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
        },
        leaderPageSchema,
        { signal },
      ),
    /** A ranked category or the trending row. The service refuses every one; the room shows that refusal as it comes. */
    rankedLeaders: (ranking: { category: string } | { trending: true }) =>
      api.query('trade', 'copy.listLeaders', { limit: LEADER_PAGE, ...ranking }, leaderPageSchema),
    leaderProfile: (leaderRef: string, signal?: AbortSignal) =>
      api.query('trade', 'copy.leaderProfile', { leaderRef }, leaderProfileSchema, { signal }),
    leaderTrades: (leaderRef: string, cursor: string | null, signal?: AbortSignal) =>
      api.query('trade', 'copy.leaderTrades', { leaderRef, limit: LEADER_TRADES_PAGE, ...(cursor ? { cursor } : {}) }, leaderTradesSchema, {
        signal,
      }),
    follows: tools.copyFollows,
    follow: (input: FollowRequest) => api.mutate('trade', 'copy.follow', input, copyFollowSchema),
    followAction: tools.copyAction,
    /** Lets the service place each copy as this person. The one-time key it answers with is never kept. */
    grantCopying: (followId: string) => api.mutate('trade', 'copy.grantSessionKey', { followId }, copyFollowSchema),
    stopCopying: (followId: string) => api.mutate('trade', 'copy.killSessionKey', { followId }, copyFollowSchema),
    followPositions: (followId: string, signal?: AbortSignal) =>
      api.query('trade', 'copy.followPositions', { followId }, z.object({ positions: z.array(copyPositionSchema) }), { signal }),
    /** Stop is close-only: new trades are fenced, the leader's closes still close what was copied (CB-copy-09). */
    stop: (followId: string) => api.mutate('trade', 'copy.stop', { followId, closeOnly: true }, ackSchema.passthrough()),
    copiedPositions: (followId: string, signal?: AbortSignal) =>
      api.query(
        'trade',
        'copy.copiedPositions',
        { followId },
        z.object({ positions: z.array(copiedPositionSchema), markets: z.array(copiedMarketSchema) }),
        { signal },
      ),
    /** Closes one copied position, whole or by an amount. The service runs one close per position and amount. */
    closePosition: (followId: string, positionId: string, qty?: string) =>
      api.mutate('trade', 'copy.closeCopiedPosition', { followId, positionId, ...(qty ? { qty } : {}) }, closePositionSchema.passthrough()),
    skipLog: (followId: string, signal?: AbortSignal) =>
      api.query('trade', 'copy.skipLog', { followId }, z.object({ items: z.array(copySkipSchema) }), { signal }),
    /** Close-all needs identity's step-up for exactly this follow and request (`trade.step_up.copy.flatten`). */
    flatten: (input: { followId: string; requestId: string; stepUpApprovalId: string | null }) =>
      api.mutate('trade', 'copy.flatten', input, ackSchema.passthrough()),
    algoPolicy: (signal?: AbortSignal) => api.query('trade', 'algo.policy', undefined, algoPolicySchema, { signal }),
    webhooks: (signal?: AbortSignal) => api.query('trade', 'signals.webhooks.list', undefined, z.array(signalWebhookSchema), { signal }),
    createWebhook: (input: { symbol: string; venueOwner: string; clientRequestId: string }) =>
      api.mutate('trade', 'signals.webhooks.create', input, signalWebhookSchema),
    leadEarnings: (signal?: AbortSignal) =>
      api.query('trade', 'copy.leadEarnings', { limit: LEAD_EARNINGS_PAGE }, leadEarningsSchema, { signal }),
    leadLevel: (signal?: AbortSignal) => api.query('trade', 'copy.leadLevel', undefined, leadLevelSchema, { signal }),
    /** Always refused `trade.copy_pnl_fee_forbidden`: a profit share is never offered. */
    setProfitShare: (percent: string) => api.mutate('trade', 'copy.setProfitShare', { percent }, z.unknown()),
    /** Always refused `trade.copy_pnl_fee_forbidden`: the platform sets no maximum ratio. */
    setMaxRatio: (ratio: string) => api.mutate('trade', 'copy.setMaxRatio', { ratio }, z.unknown()),
    platformPauses: (signal?: AbortSignal) => api.query('trade', 'copy.platformPauses', undefined, platformPausesSchema, { signal }),
    createTwap: (input: TwapRequest) => api.mutate('trade', 'algo.createTwap', input, algoSchema),
    algoList: (limit: number, signal?: AbortSignal) => api.query('trade', 'algo.list', { limit }, botListSchema, { signal }),
    algoGet: tools.algoGet,
    algoProgress: tools.algoProgress,
    algoAction: tools.algoAction,
    gridSetup: (signal?: AbortSignal) => api.query('trade', 'bots.grid.setup', undefined, gridSetupSchema, { signal }),
    gridPresets: (signal?: AbortSignal) => api.query('trade', 'bots.grid.presets', undefined, gridPresetsSchema, { signal }),
    gridCreate: (input: GridRequest) => api.mutate('trade', 'bots.grid.create', input, gridBotSchema),
    gridGet: (botId: string, signal?: AbortSignal) => api.query('trade', 'bots.grid.get', { botId }, gridBotSchema, { signal }),
    gridList: (signal?: AbortSignal) => api.query('trade', 'bots.grid.list', undefined, z.array(gridBotSchema), { signal }),
    gridStop: (botId: string) => api.mutate('trade', 'bots.grid.stop', { botId }, gridBotSchema),
    gridWithdraw: (input: GridWithdrawRequest) => api.mutate('trade', 'bots.grid.withdrawProfit', input, gridWithdrawalSchema),
    studio: (signal?: AbortSignal) =>
      api.query('quant', 'studio.list', { limit: 50 }, z.object({ strategies: z.array(studioStrategySchema) }), { signal }),
  };
}
export type RoomApi = ReturnType<typeof createRoomApi>;
